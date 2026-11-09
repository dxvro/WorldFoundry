export const login = {
  documentTitle: 'Sign in · WorldFoundry',
  title: 'Sign-in required',
  passwordIntro:
    'This WorldFoundry is protected by a password. Forgot it? On the server computer, set a new one with the command “worldfoundry reset-password” (Linux) or via “Reset password” in the Start menu (Windows).',
  tokenIntro:
    'This WorldFoundry is protected by an access token. The token is in the configuration (AUTH_TOKEN) on the server computer. It acts as the initial password and can be changed under System after signing in.',
  passwordLabel: 'Password',
  tokenLabel: 'Access token',
  retryIn: (seconds: number) => `You can try again in ${seconds} s.`,
  submit: 'Sign in',
};
