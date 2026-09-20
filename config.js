/* Blossom Ledger · config.js
 * Public settings for the website. Nothing here is secret: every visitor can see it,
 * and your backend checks Google sign-in + your authenticator code on every request.
 */
window.BLOSSOM_CONFIG = {
  // 1. Your Apps Script web app URL (Script Properties → WEBAPP_URL). It ends in /exec.
  API_URL: 'https://script.google.com/macros/s/AKfycbxixdiALIbjnGjfNrApD0yPBe8EVz5Q-Bs31LbYdJla-8dus09bb4WxvP5uv9Ey65zG/exec',

  // 2. Your Google Sign-In Client ID (ends in .apps.googleusercontent.com).
  GOOGLE_CLIENT_ID: '350753440202-aqom46fn622gar3m0v0g8veds3atkf6i.apps.googleusercontent.com'
,

  // 3. false = real data behind the login. true = sample data, no login.
  DEMO_MODE: false
};
