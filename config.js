/*
 * Optional deployment configuration.
 *
 * The ONLY thing that belongs here is a Google OAuth Client ID, and only if you
 * want the optional Drive-backup button to work without each user pasting their
 * own. An OAuth Client ID is a public identifier, not a secret — it is safe in a
 * public repo. There is no client secret anywhere in this app, because there is
 * no server to hold one.
 *
 * Leave it blank and the Drive feature simply stays off until a user supplies
 * their own ID in the "Data & Backup" tab. Everything else works regardless.
 */
window.OPT_TRACKER_CONFIG = {
  googleClientId: ''
};
