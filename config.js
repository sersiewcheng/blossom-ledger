/* Blossom Ledger · config.js
 * Public settings for the website. Nothing here is secret: every visitor can see it,
 * and your backend checks Google sign-in + your authenticator code on every request.
 */
window.BLOSSOM_CONFIG = {
  // 1. Your Apps Script web app URL (Script Properties → WEBAPP_URL). It ends in /exec.
  API_URL: 'PASTE_YOUR_WEB_APP_URL_HERE',

  // 2. Your Google Sign-In Client ID (ends in .apps.googleusercontent.com).
  GOOGLE_CLIENT_ID: 'PASTE_YOUR_CLIENT_ID_HERE',

  // 3. false = real data behind the login. true = sample data, no login.
  DEMO_MODE: false
};
