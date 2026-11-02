#!/usr/bin/env node
import { main } from "../src/cli/tui.mjs";

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  }
);
