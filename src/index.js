const smtp = require("smtp-server");
const promClient = require("prom-client");
const supabase = require("./lib/supabaseClient");
const express = require("express");
const app = express();
const { transports, createLogger, log } = require("winston");
const LokiTransport = require("winston-loki");
const options = {
  transports: [
    new LokiTransport({
      host: "http://13.126.245.89:3100",
    }),
  ],
};
const logger = createLogger(options);
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({
  register: promClient.register,
});
const totalRequestCounter = new promClient.Counter({
  name: "total_requests",
  help: "Indicates the total request to the server",
});
// app.use((req,res,next)=>{
//   totalRequestCounter.inc()
//   next()
// })
app.use(express.json());
app.get("/", (req, res) => {
  res.send("Hello World");
});
app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", promClient.register.contentType);
    const metrics = await promClient.register.metrics();
    res.send(metrics);
    // logger.info("Metrics fetched")
  } catch (err) {
    res.status(500).send(err);
  }
});

app.listen(5000, () => {
  logger.info("Express server listening on port 5000");
});

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

        if (secondaryEmailError) {
          logger.error("Failed to get secondary email:", secondaryEmailError);
          return callback(
            new Error(
              "Failed to get secondary email: " + secondaryEmailError.message
            )
          );
        }
        if (secondaryEmail) {
          userId = secondaryEmail.user_id;
          logger.info("User found in Secondary Emails", { userId });
        } else {
          return callback(
            new Error(`Recipient user not found: ${recipientUser}`)
          );
        }
      }

      // Collect email data
      const dataBuffer = [];
      stream.on("data", (chunk) => {
        dataBuffer.push(chunk);
      });

      stream.on("end", async () => {
        try {
          const data = Buffer.concat(dataBuffer).toString();
          logger.info("Email data received", { length: data.length });

          // Extract email body (HTML preferred, fallback to plain text)
          let emailBody = "";

          // For multipart emails
          if (data.includes("Content-Type: multipart/")) {
            const boundaryMatch = data.match(/boundary="([^"]+)"/);
            if (boundaryMatch && boundaryMatch[1]) {
              const boundary = boundaryMatch[1];
              const parts = data.split(`--${boundary}`);

              // First try to find HTML part
              let htmlPart = null;
              let textPart = null;

              for (const part of parts) {
                if (part.includes("Content-Type: text/html")) {
                  htmlPart = part;
                } else if (part.includes("Content-Type: text/plain")) {
                  textPart = part;
                }
              }

              // Prefer HTML over plain text
              const selectedPart = htmlPart || textPart;
              if (selectedPart) {
                // Extract content after headers (handle different header formats)
                const headerEndIndex =
                  selectedPart.indexOf("\r\n\r\n") !== -1
                    ? selectedPart.indexOf("\r\n\r\n") + 4
                    : selectedPart.indexOf("\n\n") + 2;

                if (headerEndIndex > 0) {
                  emailBody = selectedPart.substring(headerEndIndex).trim();
                }
              }
            }
          } else {
            // For single part emails, find where headers end and body begins
            const headerEndIndex =
              data.indexOf("\r\n\r\n") !== -1
                ? data.indexOf("\r\n\r\n") + 4
                : data.indexOf("\n\n") + 2;

            if (headerEndIndex > 0) {
              emailBody = data.substring(headerEndIndex).trim();
            } else {
              emailBody = data; // Fallback to full content
            }
          }

          // If we couldn't parse the body correctly, store the original content
          if (!emailBody) {
            emailBody = data;
          }
          const senderEmail = session.envelope.mailFrom.address;
          const toEmail = session.envelope.rcptTo[0].address;
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
              sender.email === senderEmail && sender.mail_service === "rainbox"
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

          // Store email in database for the recipient user
          const { error: insertError } = await supabase.from("mails").insert({
            subject: data.match(/Subject: (.*)/i)?.[1] || "",
            body: emailBody,
            user_id: userId,
            sender_id: sender.id,
          });

          if (insertError) {
            logger.error("Failed to store email:", insertError);
            return callback(new Error("Failed to store email"));
          }

          logger.info("Email stored successfully for user:", { recipientUser });
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
