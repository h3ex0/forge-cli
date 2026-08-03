import { reportCliError, runCli } from "./cli.js";

runCli().catch(reportCliError);
