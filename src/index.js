const smtp = require("smtp-server");
const promClient = require("prom-client");
const supabase = require("./lib/supabaseClient");
const express = require("express");
const { simpleParser } = require("mailparser");
const { createLogger } = require("winston");
const LokiTransport = require("winston-loki");

const app = express();

// Logger config
const logger = createLogger({
  transports: [
    new LokiTransport({
      host: "http://13.126.245.89:3100",
    }),
  ],
});

// Metrics
promClient.collectDefaultMetrics({ register: promClient.register });
const totalRequestCounter = new promClient.Counter({
  name: "total_requests",
  help: "Indicates the total request to the server",
});

// Express
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", promClient.register.contentType);
    const metrics = await promClient.register.metrics();
    res.send(metrics);
  } catch (err) {
    res.status(500).send(err);
  }
});

app.listen(5000, () => {
  logger.info("Express server listening on port 5000");
});

// SMTP
const server = new smtp.SMTPServer({
  allowInsecureAuth: true,
  authOptional: true,
  onConnect(session, callback) {
    logger.info("SMTP onConnect", { session });
    callback();
  },
  onMailFrom(address, session, callback) {
    logger.info("SMTP onMailFrom", { address, session });
    callback();
  },
  async onRcptTo(address, session, callback) {
    logger.info("SMTP onRcptTo", { address, session });
    callback();
  },
  async onData(stream, session, callback) {
    logger.info("SMTP onData event", { session });
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
        logger.error("User not found:", userError);
        logger.info("Searching in Secondary Emails");

        const { data: secondaryEmail, error: secondaryEmailError } =
          await supabase
            .from("secondary_emails")
            .select("*")
            .eq("name", recipientUser)
            .single();

        if (secondaryEmailError || !secondaryEmail) {
          logger.error("Failed to get secondary email:", secondaryEmailError);
          return callback(
            new Error(
              "Recipient user not found: " +
                (secondaryEmailError?.message || recipientUser)
            )
          );
        }

        userId = secondaryEmail.user_id;
        logger.info("User found in Secondary Emails", { userId });
      }

      const dataBuffer = [];
      stream.on("data", (chunk) => {
        dataBuffer.push(chunk);
      });

      stream.on("end", async () => {
        try {
          const rawEmail = Buffer.concat(dataBuffer);

          const parsed = await simpleParser(rawEmail);
          const subject = parsed.subject || "(No Subject)";
          const emailBody = parsed.html || parsed.text || rawEmail.toString();
          const senderEmail = session.envelope.mailFrom.address;
          const toEmail = session.envelope.rcptTo[0].address;

          logger.info("Parsed Email Info", {
            subject,
            from: parsed.from?.text,
            to: parsed.to?.text,
            date: parsed.date,
            bodySnippet: emailBody.substring(0, 200),
          });

          const { data: senders, error: sendersError } = await supabase
            .from("senders")
            .select("*")
            .eq("user_id", userId);

          if (sendersError) {
            logger.error("Failed to get senders:", sendersError);
            return callback(new Error("Failed to get senders"));
          }

          let sender = senders.find(
            (sender) =>
              sender.email === senderEmail &&
              sender.mail_service === "rainbox"
          );

          if (!sender) {
            const { error: newSenderError } = await supabase
              .from("senders")
              .insert({
                name: senderEmail.split("@")[0],
                email: senderEmail,
                domain: senderEmail.split("@")[1],
                order: senders.length + 1,
                user_id: userId,
                count: 1,
                mail_service: "rainbox",
              });

            if (newSenderError) {
              logger.error("Failed to create sender:", newSenderError);
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
              logger.error("Failed to update sender:", updateError);
              return callback(new Error("Failed to update sender"));
            }
          }

          const { error: insertError } = await supabase.from("mails").insert({
            subject,
            body: emailBody,
            user_id: userId,
            sender_id: sender.id,
          });

          if (insertError) {
            logger.error("Failed to store email:", insertError);
            return callback(new Error("Failed to store email"));
          }

          logger.info("Email stored successfully for user:", {
            recipientUser,
          });
          callback();
        } catch (err) {
          logger.error("Error processing email data:", err);
          callback(err);
        }
      });

      stream.on("error", (err) => {
        logger.error("Stream error:", err);
        callback(err);
      });
    } catch (err) {
      logger.error("Unexpected error in onData:", err);
      callback(err);
    }
  },
});

server.listen(25, "0.0.0.0", () => {
  logger.info("SMTP server listening on port 25");
});
