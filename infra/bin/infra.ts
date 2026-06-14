#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { AivfxStack } from "../lib/aivfx-stack";

// The CDK CLI overwrites CDK_DEFAULT_REGION from the active AWS profile.
// This project is deployed in eu-west-2 unless explicitly overridden.
const deployAccount = process.env.AIVFX_CDK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT;
const deployRegion = process.env.AIVFX_CDK_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-west-2";
const stackName = process.env.AIVFX_STACK_NAME ?? "AivfxStack";
const stackDescription = process.env.AIVFX_STACK_DESCRIPTION ?? "AI-assisted VFX micro-pipeline stack";

const app = new cdk.App();

new AivfxStack(app, stackName, {
  env: {
    account: deployAccount,
    region: deployRegion,
  },
  description: stackDescription,
});
