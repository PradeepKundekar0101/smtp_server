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

      const { data: user, error: userError } = await supabase
        .from("user")
        .select("*")
        .eq("username", recipientUser)
        .single();

      if (userError) {
        console.error("User not found:", userError);
        return callback(
          new Error(`Recipient user not found: ${recipientUser}`)
        );
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

          // Store email in database for the recipient user
          const { error: insertError } = await supabase.from("mail").insert({
            from: session.envelope.mailFrom.address,
            to: session.envelope.rcptTo[0].address,
            subject: data.match(/Subject: (.*)/i)?.[1] || "",
            body: emailBody,
            userId: user.id,
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
