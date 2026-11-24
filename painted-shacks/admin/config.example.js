// Copy this file to config.js on the server and fill in the two values.
// Both are PUBLIC values (Supabase "publishable" key), safe to ship to the browser:
// row level security in the database decides what each signed-in person can see.
// Never put the service_role key or the Blink API key here.
window.PS_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseKey: "sb_publishable_..."
};
