// cli tool for S3

import * as assert from "assert";
import * as program from "commander";
import { existsSync, readFileSync, writeFileSync } from "fs";
import * as _ from "lodash";
import * as Web3 from "web3";
import * as winston from "winston";

import {
  Administration,
  BaseSecurity,
  OfflineTranscriptEntry,
  SimplifiedTokenLogic,
  TokenFront,
  adminSpecRT,
  newResolver,
  baseSecurityRT,
} from "../src";
import { txReceipt } from "../src/Web3";

import {
  Config,
  GasReport,
  configRT,
  onlineReportAbrRT,
  specRT
} from "./cli/Types";
import { initS3 } from "./cli/Init";
import { issueOnline } from "./cli/Online";
import { publishInteractive } from "./cli/Publish";
import { gweiToWei } from "./cli/Util";

// ~~~~~~~~~~~~~ //
// CONFIGURATION //
// ~~~~~~~~~~~~~ //

const log = winston.createLogger({
  level: "info",
  format: winston.format.simple(),
  transports: [new winston.transports.Console()]
});

process.stdin.setEncoding("utf8");

const PWD = process.env["PWD"];
const defaultConfig = `${PWD}/S3-conf.json`;
const defaultSpec = `${PWD}/S3-spec.json`;
const defaultReport = `${PWD}/S3-report.json`;
const defaultInit = `${PWD}/S3-CapTables.json`;
const defaultNewResolver = `${PWD}/S3-newResolver.json`;
const defaultAdminSpec = `${PWD}/S3-administration.json`;

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //
// INITIALIZE S3 WITH A CAP TABLE //
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

program
  .command("init")
  .option("-c, --config [file]", "path the configuration file", defaultConfig)
  .option(
    "-o, --output [file]",
    "path to the output file, with the action report",
    defaultInit
  )
  .action(async env => {
    checkOutput(env.output);

    const config: Config = JSON.parse(readFileSync(env.config, "utf8"));
    const result = await initS3(config);

    log.info(`CapTables instance @ ${result.capTables}`);

    writeFileSync(env.output, JSON.stringify(result.transcript), "utf8");
  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //
// ISSUE SECURITIES IN ONLINE MODE //
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

program
  .command("issue-online")
  .option("-c, --config [file]", "path the configuration file", defaultConfig)
  .option(
    "-d, --declaration [file]",
    "path to the declaration file",
    defaultSpec
  )
  .option(
    "-o, --output [file]",
    "path to the output file, with the action report",
    defaultReport
  )
  .action(async env => {
    checkOutput(env.output);

    // Let's read in the configuration
    const config: Config = configRT
      .decode(JSON.parse(readFileSync(env.config, "utf8")))
      .getOrElseL(errs => {
        throw new Error("Invalid config.");
      });

    // ... and the program that we're supposed to execute
    const spec = specRT
      .decode(JSON.parse(readFileSync(env.declaration, "utf8")))
      .getOrElseL(errs => {
        throw new Error("Invalid spec.");
      });

    const securities: Array<BaseSecurity> = [];
    spec.securityPaths.forEach(path =>
      baseSecurityRT.decode(JSON.parse(readFileSync(path, "utf8"))).fold(
        errs => {
          log.warn(`${path} contains an invalid spec`);
        },
        security => {
          securities.push(security);
        }
      )
    );

    const web3 = new Web3(
      new Web3.providers.HttpProvider(
        `http://${config.net.host}:${config.net.port}`
      )
    );

    // We'll need to figure out gas prices
    const gasPrice = () => {
      const gasReport: GasReport = JSON.parse(
        readFileSync(config.gasReportPath, "utf8")
      );
      return web3.toWei(gasReport.safeLow, "gwei");
    };

    const result = await issueOnline(
      config,
      spec,
      securities,
      gasPrice,
      web3,
      log
    );

    writeFileSync(env.output, JSON.stringify(result), "utf8");
  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~ //
// AUDIT A SECURITY ISSUANCE //
// ~~~~~~~~~~~~~~~~~~~~~~~~~ //

program
  .command("audit-issuance")
  .option("-c, --config [file]", "path the configuration file", defaultConfig)
  .option(
    "-d, --declaration [file]",
    "path to the declaration file",
    defaultSpec
  )
  .option(
    "-o, --output [file]",
    "path to the output file, with the action report",
    defaultReport
  )
  .action(async env => {
    // Let's read in the configuration
    const config: Config = JSON.parse(readFileSync(env.config, "utf8"));

    // ... and the program that we're supposed to execute
    const spec = specRT
      .decode(JSON.parse(readFileSync(env.declaration, "utf8")))
      .getOrElseL(errs => {
        throw new Error("Invalid spec.");
      });

    const securities: Array<BaseSecurity> = [];
    spec.securityPaths.forEach(path =>
      baseSecurityRT.decode(JSON.parse(readFileSync(path, "utf8"))).fold(
        errs => {
          log.warning(`${path} contains an invalid spec`);
        },
        security => {
          securities.push(security);
        }
      )
    );

    const web3 = new Web3(
      new Web3.providers.HttpProvider(
        `http://${config.net.host}:${config.net.port}`
      )
    );

    const report = onlineReportAbrRT
      .decode(JSON.parse(readFileSync(env.output, "utf8")))
      .getOrElseL(errs => {
        throw new Error("Unable to decode report");
      });

    securities.forEach(security => {
      log.info(`Auditing ${security.metadata.name}`);

      const deployment = report.ethState.securities.find(
        x => x.name === security.metadata.name
      );

      if (deployment === undefined) {
        log.error("Deployment not found.");
      } else {
        const tokenFront = web3.eth
          .contract(TokenFront.abi)
          .at(deployment.front);

        assert.equal(
          tokenFront.owner.call(),
          security.admin,
          "TokenFront owner"
        );

        assert.equal(
          tokenFront.tokenLogic.call(),
          deployment.logic,
          "TokenFront logic"
        );

        security.investors.forEach(investor => {
          assert.equal(
            tokenFront.balanceOf.call(investor.address).toString(),
            investor.amount,
            investor.address + " balance"
          );
        });

        const tokenLogic = web3.eth
          .contract(SimplifiedTokenLogic.abi)
          .at(deployment.logic);

        assert.equal(
          tokenLogic.owner.call(),
          security.admin,
          "SimplifiedLogic owner"
        );

        assert.equal(
          tokenLogic.resolver.call(),
          security.resolver,
          "SimplifiedLogic resolver"
        );

        assert.equal(
          tokenLogic.front.call(),
          deployment.front,
          "SimplifiedLogic front"
        );

        log.info("Audit passed");
      }
    });
  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //
// CHANGE THE RESOLVER ON A SIMPLIFIEDTOKENLOGIC INSTANCE //
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

// TODO Trezor support
program
  .command("new-resolver")
  .option(
    "-s, --simplifiedTokenLogic <address>",
    "the address of the simplified token logic to change"
  )
  .option(
    "-a, --admin <privkey>",
    "the base64 encoded private key in control of the token logic"
  )
  .option("-g, --gasPrice [gasPrice]", "the starting gas price in gwei", 5)
  .option("-c, --chainId [chain]", "which chain to use", 4)
  .option("-n, --nonce <value>", "the current nonce")
  .option(
    "-o, --outputFile [file]",
    "where to write the transcript",
    defaultNewResolver
  )
  .action(async env => {
    const admin = Buffer.from(env.admin);

    const gasPrices = _.range(env.gasPrice, 10 * env.gasPrice, 2);

    const result = newResolver(env.simplifiedTokenLogic, admin, {
      gasPrices: gasPrices.map(gweiToWei),
      nonce: parseInt(env.nonce),
      chainId: parseInt(env.chainId)
    });

    console.log("New resolver address:", result.resolverAddress);
    console.log("New resolver key:", result.resolverKey.toString("base64"));

    writeFileSync(env.outputFile, JSON.stringify(result.transcript), "utf8");
  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //
// PUBLISH NEW RESOLVER TRANSACTION //
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

program
  .command("publish-new-resolver")
  .option("-c, --config [file]", "configuration file", defaultConfig)
  .option("-t, --transcript [file]", "transcript file", defaultNewResolver)
  .action(async env => {
    try {
      const config: Config = JSON.parse(readFileSync(env.config, "utf8"));

      const web3 = new Web3(
        new Web3.providers.HttpProvider(
          `http://${config.net.host}:${config.net.port}`
        )
      );

      const entry: OfflineTranscriptEntry = JSON.parse(
        readFileSync(env.transcript, "utf8")
      );

      await publishInteractive(entry, web3, log);

      log.info("done");
    } catch (err) {
      log.error("Oh no!");
      log.error(err);
    }
  });

// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //
// DEPLOY ADMINISTRATION CONTRACT //
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ //

program
  .command("new-administration")
  .option("-c, --config [file]", "configuration file", defaultConfig)
  .option("-s, --spec [file]", "specification file", defaultAdminSpec)
  .option("-o, --output [file]", "transcript file", defaultReport)
  .option("-g, --gasPrice [gweiPrice]", "gas price to use in gwei", 5)
  .action(env => {
    log.info("Running 'new-administration'");
    configRT.decode(JSON.parse(readFileSync(env.config, "utf8"))).fold(
      errs => {
        log.error("Malformed configuration");
      },
      config => {
        const web3 = new Web3(
          new Web3.providers.HttpProvider(
            `http://${config.net.host}:${config.net.port}`
          )
        );

        adminSpecRT.decode(JSON.parse(readFileSync(env.spec, "utf8"))).fold(
          errs => {
            log.error("Malformed administration spec");
          },
          async spec => {
            checkOutput(env.transcript);

            log.info("All configurations appear correct. Submitting transaction.");
            const { transactionHash } = web3.eth
              .contract(Administration.abi)
              .new(spec.cosignerA, spec.cosignerB, spec.cosignerC, {
                data: Administration.bytecode,
                from: config.controller,
                gas: 1.5e6,
                gasPrice: web3.toWei(env.gasPrice, "gwei")
              });

            log.info(`Tx ${transactionHash} submitted. Awaiting receipt....`);

            const adminAddress = (await txReceipt(web3.eth, transactionHash))
              .contractAddress;

            log.info(`Administration deployed to: ${adminAddress}`);

            writeFileSync(env.output, JSON.stringify({ adminAddress }), "utf8");
          }
        );
      }
    );
  });

program
  .command("audit-administration")
  .option("-c, --config [file]", "configuration file", defaultConfig)
  .option("-s, --spec [file]", "specification file", defaultAdminSpec)
  .option("-t, --transcript [file]", "transcript file", defaultReport)
  .action(env => {
    configRT.decode(JSON.parse(readFileSync(env.config, "utf8"))).fold(
      errs => {
        log.error("Malformed configuration");
      },
      config => {
        const web3 = new Web3(
          new Web3.providers.HttpProvider(
            `http://${config.net.host}:${config.net.port}`
          )
        );

        adminSpecRT.decode(JSON.parse(readFileSync(env.spec, "utf8"))).fold(
          errs => {
            log.error("Malformed administration spec");
          },
          spec => {
            try {
              const { adminAddress } = JSON.parse(
                readFileSync(env.transcript, "utf8")
              );

              const admin = web3.eth
                .contract(Administration.abi)
                .at(adminAddress);

              if (spec.tokenLogic !== null) {
                assert.equal(
                  admin.targetLogic.call(),
                  spec.tokenLogic,
                  "tokenLogic"
                );
              }

              if (spec.tokenFront !== null) {
                assert.equal(
                  admin.targetFront.call(),
                  spec.tokenFront,
                  "tokenFront"
                );
              }

              assert.equal(admin.cosignerA.call(), spec.cosignerA, "cosignerA");
              assert.equal(admin.cosignerB.call(), spec.cosignerB, "cosignerB");
              assert.equal(admin.cosignerC.call(), spec.cosignerC, "cosignerC");

              log.info("All checks passed");
            } catch (err) {
              log.error("Audit failed: " + err.message);
            }
          }
        );
      }
    );
  });

program.parse(process.argv);

// ~~~~~~~ //
// HELPERS //
// ~~~~~~~ //

function checkOutput(outputFile: string) {
  // We will never overwrite the output file
  if (existsSync(outputFile)) {
    log.error(
      `The output target ${outputFile} exists already.  Please deal with it.  Aborting!`
    );
    process.exitCode = 1;
    return;
  }
}
