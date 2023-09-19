#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { AwsDsInitStack } from '../lib/aws-ds-init-stack';
import { AwsDsS3EfsStack } from '../lib/aws-ds-s3-efs-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
const dsInitStack = new AwsDsInitStack(app, 'AwsDsInitStack', { env });
const dsStack = new AwsDsS3EfsStack(app, 'AwsDsS3EfsStack', { env, awsDsInitProps: dsInitStack.awsDsInitProps });