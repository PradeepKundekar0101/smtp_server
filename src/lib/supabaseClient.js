const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    db: {
      schema: "rainbox",
    },
  }
);

// Enable debugging to see what's happening
supabase.from("users").select("*").then(console.log).catch(console.error);

module.exports = supabase;
