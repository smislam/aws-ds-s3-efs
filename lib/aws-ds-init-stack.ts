import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { GatewayVpcEndpointAwsService, InterfaceVpcEndpointAwsService, Peer, Port, SecurityGroup, SelectedSubnets, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AccessPoint, FileSystem } from 'aws-cdk-lib/aws-efs';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface AwsDsInitProps {
  vpc: Vpc,
  sourceBucket: Bucket,
  destEFS: FileSystem,
  fs_sg: SecurityGroup,
  egressSubnets: SelectedSubnets,
  dsLogGroup: LogGroup,
  dataSyncRole: Role,
  accessPoint: AccessPoint
}

export class AwsDsInitStack extends Stack {
  public readonly awsDsInitProps: AwsDsInitProps;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpc = new Vpc(this, 'app-vpc', {
      maxAzs: 2,
      natGateways: 1,
      gatewayEndpoints: {
        s3: {service: GatewayVpcEndpointAwsService.S3}
      }
    });
    
    const vpce_sg = new SecurityGroup(this, 'vpc-sg', {
      vpc:vpc
    });

    vpce_sg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443));

    const vpces = [
      InterfaceVpcEndpointAwsService.ELASTIC_FILESYSTEM,
      InterfaceVpcEndpointAwsService.LAMBDA,
      InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      InterfaceVpcEndpointAwsService.CLOUDTRAIL,
      InterfaceVpcEndpointAwsService.CLOUDWATCH,
      InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      InterfaceVpcEndpointAwsService.CLOUDWATCH_EVENTS,
      InterfaceVpcEndpointAwsService.DATASYNC
    ];

    vpces.forEach(vpce => vpc.addInterfaceEndpoint(
      vpce.shortName, {
        service: vpce,
        securityGroups: [vpce_sg],
        privateDnsEnabled: true
      }
    ));

    const egressSubnets = vpc.selectSubnets({
      subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      onePerAz: true
    });

    const sourceBucket = new Bucket(this, 's3-bucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED
    });

    const fs_sg = new SecurityGroup(this, 'fs-sg', { vpc: vpc });

    const destEFS = new FileSystem(this, 'my-efs', {
      vpc: vpc,
      vpcSubnets: egressSubnets,
      removalPolicy: RemovalPolicy.DESTROY,
      securityGroup: fs_sg,
      encrypted: true,
    });
    destEFS.connections.allowDefaultPortFrom(fs_sg);    

    const accessPoint = new AccessPoint(this, 'efs-ap', {
      fileSystem: destEFS,
      path: '/efs/appname/file'
    });
    accessPoint.applyRemovalPolicy(RemovalPolicy.DESTROY);

    const dsLogGroup = new LogGroup(this, 'ds-lg', {
      removalPolicy: RemovalPolicy.DESTROY,
      retention: RetentionDays.ONE_DAY
    });
    
    const dataSyncRole = new Role(this, 'ds-iam-role', {
      assumedBy: new ServicePrincipal('datasync.amazonaws.com')
    });

    sourceBucket.grantRead(dataSyncRole);
    dsLogGroup.grantWrite(dataSyncRole);

    // Copy policies from here: https://docs.aws.amazon.com/datasync/latest/userguide/using-identity-based-policies.html
    dataSyncRole.addToPolicy(new PolicyStatement({
      actions: [ 
        's3:GetBucketLocation',
        's3:ListBucket',
        's3:ListObjectsV2',
        's3:ListBucketMultipartUploads'
       ],
      effect: Effect.ALLOW,
      resources: [sourceBucket.bucketArn],
    }));
    dataSyncRole.addToPolicy(new PolicyStatement({
      actions: [ 
        's3:AbortMultipartUpload',
        's3:DeleteObject',
        's3:GetObject',
        's3:ListMultipartUploadParts',
        's3:GetObjectTagging',
        's3:PutObjectTagging',
        's3:PutObject',
        's3:ListObjectsV2'
       ],
      effect: Effect.ALLOW,
      resources: [sourceBucket.arnForObjects('*')]
    }));
    dataSyncRole.addToPolicy(new PolicyStatement({
      actions: [ 
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStream'
       ],
      effect: Effect.ALLOW,
      resources: [dsLogGroup.logGroupArn]
    }));
    dataSyncRole.addToPolicy(new PolicyStatement({
      actions: [ 
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite'
       ],
      effect: Effect.ALLOW,
      resources: [destEFS.fileSystemArn]
    }));

    this.awsDsInitProps = {
      vpc: vpc,
      sourceBucket: sourceBucket,
      destEFS: destEFS,
      fs_sg: fs_sg,      
      egressSubnets: egressSubnets,
      dsLogGroup: dsLogGroup,
      dataSyncRole: dataSyncRole,
      accessPoint: accessPoint
    }

    new CfnOutput(this, 'sourceBucket', {
      value: sourceBucket.bucketName,
      exportName: `${props?.stackName}-sourceBucket`
    });
  }
}
