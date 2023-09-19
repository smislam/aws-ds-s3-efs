import * as cdk from 'aws-cdk-lib';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { CfnLocationEFS, CfnLocationS3, CfnTask } from 'aws-cdk-lib/aws-datasync';
import { CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { Runtime, Tracing, FileSystem as lfs } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AwsDsInitProps } from './aws-ds-init-stack';
import path = require('path');

interface AwsDsS3EfsProps extends cdk.StackProps {
  awsDsInitProps: AwsDsInitProps,
}

export class AwsDsS3EfsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AwsDsS3EfsProps) {
    super(scope, id, props);

    const vpc = props.awsDsInitProps.vpc;
    const sourceBucket = props.awsDsInitProps.sourceBucket;
    const destEFS = props.awsDsInitProps.destEFS;
    const fs_sg = props.awsDsInitProps.fs_sg;
    const egressSubnets = props.awsDsInitProps.egressSubnets;
    const dsLogGroup = props.awsDsInitProps.dsLogGroup;
    const dataSyncRole = props.awsDsInitProps.dataSyncRole;
    const accessPoint = props.awsDsInitProps.accessPoint;

    //using L1 constructs urgh!
    const dsS3 = new CfnLocationS3(this, 'ds-s3', {
      s3Config: {
        bucketAccessRoleArn: dataSyncRole.roleArn
      },
      s3BucketArn: sourceBucket.bucketArn,
    });
    dsS3.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  
    //We need :to create mount and add data sync task for each subnets with EFS
    egressSubnets.subnets.map((v, i) => {

      const dsEfs = new CfnLocationEFS(this, `ds-efs-${i}`, {
        ec2Config: {
          securityGroupArns: [`arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:security-group/${fs_sg.securityGroupId}`],
          subnetArn: `arn:aws:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:subnet/${v.subnetId}`
        },
        efsFilesystemArn: destEFS.fileSystemArn,        
        accessPointArn: accessPoint.accessPointArn,
        inTransitEncryption: 'TLS1_2',
        fileSystemAccessRoleArn: dataSyncRole.roleArn
        
      });
      dsEfs.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

      const syncTask = new CfnTask(this, `ds-task-${i}`, {
        sourceLocationArn: dsS3.attrLocationArn,
        destinationLocationArn: dsEfs.attrLocationArn,
        cloudWatchLogGroupArn: dsLogGroup.logGroupArn,
        options: {
          logLevel: 'TRANSFER',
          transferMode: 'CHANGED',
          verifyMode: 'ONLY_FILES_TRANSFERRED'
        },
        // restriction each hour
        schedule: {
          scheduleExpression: 'cron(0 * * * ? *)'
        }
      });
      syncTask.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);  
    });

    
    const lambdaLocalMountPath = '/mnt/files'; 
    const tester_lambda = new NodejsFunction(this, 'test-file-lambda', {
      vpc,
      handler: 'handler',
      runtime: Runtime.NODEJS_18_X,
      entry: path.join(__dirname, '/../lambda/file_transfer_test.ts'),
      environment: {
        EFS_PATH: lambdaLocalMountPath
      },
      filesystem: lfs.fromEfsAccessPoint(accessPoint, lambdaLocalMountPath),
      logRetention: RetentionDays.ONE_DAY,
      tracing: Tracing.ACTIVE
    });    
    destEFS.connections.allowDefaultPortFrom(tester_lambda);

    // Saved by the bell (Thank you): https://github.com/aws/aws-cdk/issues/18759
    destEFS.connections.securityGroups.forEach((fssg) => {
      fssg.node.findAll().forEach((child)=> {
        if (child instanceof CfnSecurityGroupIngress &&
          tester_lambda.connections.securityGroups.some(({ securityGroupId }) => securityGroupId === child.sourceSecurityGroupId)) {
          fssg.node.tryRemoveChild(child.node.id);
        }
      });
    });

    tester_lambda.connections.allowToDefaultPort(destEFS);

    const api = new LambdaRestApi(this, 'test-api', {
      handler: tester_lambda
    });

  }
}
