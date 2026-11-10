WorldFoundry (Windows)

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.

Recommended: use the installer "worldfoundry-<version>-setup.exe". It sets WorldFoundry up as a
Windows service (starts with Windows, shuts the game servers down cleanly).

This ZIP is the portable variant without installation and without a service:

  1. Extract the ZIP to any location (not a write-protected folder).
  2. Run start-portable.cmd. On the first start the folder "data" is created with the configuration,
     the database and the servers, plus the file data\credentials.txt with the access token.
  3. Web interface: http://localhost:3000
  4. Stop with Ctrl+C in the window. The game servers are stopped and their worlds are saved.

By default the portable variant only listens on this computer (HOST=127.0.0.1). For access from the
network, set HOST=0.0.0.0 in data\worldfoundry.env.


Password: The access token in data\credentials.txt is the first password. You can set your own in the
web interface under "System". If you forget it, run reset-password.cmd (it shows a new password).

More information: see README.md in the project (section "Installation") and the docs folder (INSTALL.md).
Licenses of the bundled components: THIRD-PARTY-NOTICES.txt
