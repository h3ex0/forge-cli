import { reportCliError, runCli } from "./cli.js";

process.on("uncaughtException", reportCliError);
process.on("unhandledRejection", reportCliError);

runCli().catch(reportCliError);
