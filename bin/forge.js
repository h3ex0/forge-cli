#!/usr/bin/env node
import("../dist/index.js").catch((err) => {
  console.error("Failed to start forge:", err);
  process.exit(1);
});
