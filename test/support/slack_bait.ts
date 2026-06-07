// A FAKE Slack-bot-token-shaped string used as static-analysis test bait (gitleaks detects it; the parser
// redacts it). It is ASSEMBLED at runtime from non-secret parts so the literal `xoxb-…` token NEVER appears
// contiguously in committed source — GitHub secret-scanning push-protection (GH013) blocks a literal Slack
// token, and the project rule is to never vendor fake secrets (see the migration memory / the adversarial
// secrets-corpus decision). The assembled value is the real Slack-bot-token pattern, so gitleaks still
// flags it when a test writes it to a temp file, and the parser fixtures store SLACK_BAIT_PLACEHOLDER which
// both the TS test loader and the Python parity ref substitute back to this value.
export const SLACK_BAIT_TOKEN = ["xoxb", "1234567890123", "1234567890123", "aBcDeFgHiJkLmNoPqRsTuVwX"].join(
  "-",
);

/** The literal placeholder stored in recorded gitleaks JSON fixtures in place of {@link SLACK_BAIT_TOKEN}. */
export const SLACK_BAIT_PLACEHOLDER = "__SLACK_BAIT_TOKEN__";
