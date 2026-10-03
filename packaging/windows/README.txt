AWS Tool Web - portable build for Windows (x64)
================================================

No installation needed: Node.js is bundled in the "runtime" folder.

Start
  Double-click "AWS Tool Web.cmd". The app opens at http://localhost:8080
  Close the console window (or press Ctrl+C) to stop it.

Where things are stored
  AWS profiles     %USERPROFILE%\.aws\config and credentials (shared with the AWS CLI)
  Connections and  "data" folder next to this file, so the whole folder can be
  data models      moved to another PC or a USB drive.

Settings
  Run from a command prompt with environment variables to change defaults:
    set PORT=9090
    set APP_PASSWORD=change-me
    "AWS Tool Web.cmd"
  See https://github.com/francisdinhtrung/aws-tool-web#environment-variables

Notes
  - The server listens on 127.0.0.1 only. Set HOST=0.0.0.0 (and APP_PASSWORD)
    only if you really need to reach it from another machine.
  - Windows SmartScreen may warn about the unsigned .cmd file the first time.
    If the zip was downloaded, you can also right-click it > Properties > Unblock
    before extracting.

Upgrade
  Extract the new version to a new folder and copy the "data" folder over.
