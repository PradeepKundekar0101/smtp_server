const smtp = require("smtp-server");
const supabase = require("./lib/supabaseClient");

const server = new smtp.SMTPServer({
  allowInsecureAuth: true,
  authOptional: true,
  onConnect(session, callback) {
    console.log("onConnect", session);
    callback();
  },
  onMailFrom(address, session, callback) {
    console.log("onMailFrom", address, session, callback);
    callback();
  },
  async onRcptTo(address, session, callback) {
    console.log("onRcptTo", address, session, callback);
    callback();
  },
  async onData(stream, session, callback) {
    console.log("onData", stream, session, callback);
    try {
      const recipientUser = session.envelope.rcptTo[0].address.split("@")[0];

      console.log("Looking for user:", recipientUser);
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("*")
        .eq("user_name", recipientUser)
        .single();
      let userId = user?.id;
      if (userError || !user) {
        console.error("User not found:", userError);
        console.log("Searching in Secondary Emails");

        const { data: secondaryEmail, error: secondaryEmailError } =
          await supabase
            .from("secondary_emails")
            .select("*")
            .eq("name", recipientUser)
            .single();

        if (secondaryEmailError) {
          console.error("Failed to get secondary email:", secondaryEmailError);
          return callback(
            new Error(
              "Failed to get secondary email: " + secondaryEmailError.message
            )
          );
        }
        if (secondaryEmail) {
          userId = secondaryEmail.user_id;
          console.log("User found in Secondary Emails:", userId);
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
          console.log("Email data received:", data);

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
            console.error("Failed to get senders:", sendersError);
            return callback(new Error("Failed to get senders"));
          }
          let sender = senders.find((sender) => sender.email === senderEmail);
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
              console.error("Failed to create sender:", newSenderError);
              return callback(new Error("Failed to create sender"));
            }
            const { data: newSenderData, error: newSenderDataError } =
              await supabase
                .from("senders")
                .select("*")
                .eq("email", senderEmail)
                .single();
            sender = newSenderData;
          } else {
            const { error: updateError } = await supabase
              .from("senders")
              .update({ count: sender.count + 1 })
              .eq("id", sender.id);
            if (updateError) {
              console.error("Failed to update sender:", updateError);
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
            console.error("Failed to store email:", insertError);
            return callback(new Error("Failed to store email"));
          }

          console.log("Email stored successfully for user:", recipientUser);
          callback();
        } catch (err) {
          console.error("Error processing email data:", err);
          callback(err);
        }
      });

      stream.on("error", (err) => {
        console.error("Stream error:", err);
        callback(err);
      });
    } catch (err) {
      console.error("Unexpected error in onData:", err);
      callback(err);
    }
  },
});

server.listen(25, "0.0.0.0", () => {
  console.log("Server listening on port 25");
});
