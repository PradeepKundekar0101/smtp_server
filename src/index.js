const smtp = require("smtp-server");
const promClient = require("prom-client");
const supabase = require("./lib/supabaseClient");
const express = require("express");
const { simpleParser } = require("mailparser");
const { transports, createLogger, format } = require("winston");
const LokiTransport = require("winston-loki");
const path = require("path");
const { generateMailImageUrl } = require("./utils");

const app = express();

// === Logger Setup ===
const logger = createLogger({
  level: "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new LokiTransport({ host: "http://13.126.245.89:3100" }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
  ],
});

// === Prometheus Setup ===
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ register: promClient.register });

const totalRequestCounter = new promClient.Counter({
  name: "total_requests",
  help: "Indicates the total request to the server",
});

// === Express Routes ===
app.use(express.json());

app.get("/", (req, res) => res.send("Hello World"));

app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", promClient.register.contentType);
    const metrics = await promClient.register.metrics();
    res.send(metrics);
  } catch (err) {
    res.status(500).send(err);
  }
});

app.listen(5000, () => logger.info("Express server listening on port 5000"));

// === SMTP Server Setup ===
const server = new smtp.SMTPServer({
  allowInsecureAuth: true,
  authOptional: true,

  onConnect(session, callback) {
    logger.info("SMTP onConnect", { session });
    callback();
  },

  onMailFrom(address, session, callback) {
    logger.info("SMTP onMailFrom", { address });
    callback();
  },

  async onRcptTo(address, session, callback) {
    logger.info("SMTP onRcptTo", { address });
    callback();
  },

  async onData(stream, session, callback) {
    logger.info("SMTP onData event", { envelope: session.envelope });

    totalRequestCounter.inc();

    try {
      const recipientUser = session.envelope.rcptTo[0].address.split("@")[0];
      logger.info("Looking for user", { recipientUser });

      const { data: user, error: userError } = await supabase
        .from("users")
        .select("*")
        .eq("user_name", recipientUser)
        .single();

      let userId = user?.id;

      if (userError || !user) {
        logger.warn("User not found in users table", { userError });
        const { data: secondaryEmail, error: secondaryEmailError } =
          await supabase
            .from("secondary_emails")
            .select("*")
            .eq("name", recipientUser)
            .single();

        if (secondaryEmailError || !secondaryEmail) {
          logger.error("Failed to get secondary email", {
            secondaryEmailError,
          });
          return callback(
            new Error(`Recipient user not found: ${recipientUser}`)
          );
        }

        userId = secondaryEmail.user_id;
        logger.info("User found in secondary_emails", { userId });
      }

      const dataBuffer = [];
      stream.on("data", (chunk) => dataBuffer.push(chunk));

      stream.on("end", async () => {
        try {
          const buffer = Buffer.concat(dataBuffer);
          const parsed = await simpleParser(buffer);

          const metadata = {
            subject: parsed.subject || "",
            messageId: parsed.messageId,
            date: parsed.date,
            from: parsed.from?.text,
            to: parsed.to?.text,
            cc: parsed.cc?.text,
            bcc: parsed.bcc?.text,
            headers: Object.fromEntries(parsed.headers || []),
          };

          logger.info("Parsed email metadata", {
            envelope: session.envelope,
            metadata,
          });

          const emailBody = parsed.html || parsed.text || "";

          const senderHeader = parsed.from?.value?.[0];
          const senderEmail = senderHeader?.address;
          const senderName = senderHeader?.name || senderEmail?.split("@")[0];

          const { data: senders, error: sendersError } = await supabase
            .from("senders")
            .select("*")
            .eq("user_id", userId);

          if (sendersError) {
            logger.error("Failed to get senders", sendersError);
            return callback(new Error("Failed to get senders"));
          }

          let sender = senders.find(
            (s) => s.email === senderEmail && s.mail_service === "rainbox"
          );

          if (!sender) {
            const imageUrl = generateMailImageUrl(senderEmail.split("@")[1]);
            const { error: insertSenderError } = await supabase
              .from("senders")
              .insert({
                name: senderName,
                email: senderEmail,
                domain: senderEmail.split("@")[1],
                order: senders.length + 1,
                user_id: userId,
                count: 1,
                image_url: imageUrl,
              });

            if (insertSenderError) {
              logger.error("Failed to create sender", insertSenderError);
              return callback(new Error("Failed to create sender"));
            }

            const { data: newSenderData, error: newSenderDataError } =
              await supabase
                .from("senders")
                .select("*")
                .eq("email", senderEmail)
                .eq("mail_service", "rainbox")
                .single();

            sender = newSenderData;
          } else {
            const { error: updateError } = await supabase
              .from("senders")
              .update({ count: sender.count + 1 })
              .eq("id", sender.id);

            if (updateError) {
              logger.error("Failed to update sender", updateError);
              return callback(new Error("Failed to update sender"));
            }
          }

          const mailPayload = {
            subject: metadata.subject,
            body: emailBody,
            user_id: userId,
            sender_id: sender.id,
          };

          const { error: insertError } = await supabase
            .from("mails")
            .insert(mailPayload);

          if (insertError) {
            logger.error("Failed to store email", insertError);
            return callback(new Error("Failed to store email"));
          }

          logger.info("Email saved to DB", { subject: mailPayload.subject });
          callback();
        } catch (err) {
          logger.error("Error parsing/storing email", err);
          callback(err);
        }
      });

      stream.on("error", (err) => {
        logger.error("Stream error", err);
        callback(err);
      });
    } catch (err) {
      logger.error("Unexpected error in onData", err);
      callback(err);
    }
  },
});

server.listen(25, "0.0.0.0", () => {
  logger.info("SMTP server listening on port 25");
});
