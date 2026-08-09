#!/usr/bin/env node
import { brandElectronDevApp } from "../dev-branding.mjs";

const result = brandElectronDevApp();
if (result.branded) {
  process.stdout.write("[desktop] branded local Electron.app as CareerRat\n");
}
