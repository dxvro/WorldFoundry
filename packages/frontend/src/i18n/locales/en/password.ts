// Must mirror locales/de/password.ts exactly (a missing or extra key is a type error).
export const password = {
  title: 'Password',
  describeChange: 'Change the password of the web interface',
  describeSet: 'Protect the web interface from unauthorised access',
  noPasswordTitle: 'No password is set',
  noPasswordText:
    'Anyone who can reach this computer on the network can start servers, run console commands and change settings. Please set a password.',
  signedInWithPassword: 'You sign in with the password that is set here.',
  signedInWithToken:
    'At the moment the access token (AUTH_TOKEN) from the configuration counts as the password. A password of your own replaces it for signing in to the browser.',
  otherSessionsEnd: 'After the change, all other sign-ins are ended; this one stays signed in.',
  current: 'Current password',
  currentHint: 'As long as no password of your own is set, the access token is the password.',
  next: 'New password',
  repeat: 'Repeat new password',
  minLength: (min: number) => `At least ${min} characters.`,
  mismatch: 'The two entries do not match.',
  changedTitle: 'The password has been changed',
  setTitle: 'The password has been set',
  doneText: 'All other sign-ins have been ended. This session stays signed in.',
  change: 'Change password',
  set: 'Set password',
  tokenNoteStart: 'The access token (AUTH_TOKEN) in the configuration file stays unchanged and still applies to scripts and the API (',
  tokenNoteEnd:
    '), including the update service. Forgot the password? On the server computer, run “worldfoundry reset-password” (Linux) or choose “Reset password” in the Start menu (Windows).',
  strength: {
    tooShort: 'Too short',
    tooShortHint: (min: number, missing: number) => `At least ${min} characters (${missing} still missing).`,
    weak: 'Weak',
    weakHint: 'Better: mix several words, digits or special characters and choose a longer password.',
    fair: 'Fair',
    fairHint: 'With 14 or more characters and mixed character types it becomes strong.',
    strong: 'Strong',
    strongHint: 'Good choice.',
  },
};
