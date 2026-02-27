#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";

import { AivfxStack } from "../lib/aivfx-stack";

const app = new cdk.App();

new AivfxStack(app, "AivfxStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "eu-west-2",
  },
  description: "AI-assisted VFX micro-pipeline stack",
});
