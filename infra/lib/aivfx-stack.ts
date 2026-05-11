import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";

export class AivfxStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const appName = this.node.tryGetContext("appName") ?? process.env.APP_NAME ?? "aivfx";
    const webBucketOverride = process.env.WEB_BUCKET_OVERRIDE?.trim() ?? "";
    const manageAppCloudFront = (process.env.MANAGE_APP_CLOUDFRONT ?? "false").toLowerCase() === "true";
    const webPublicBaseUrl = process.env.WEB_PUBLIC_BASE_URL?.trim() ?? "";
    const cognitoRedirectSignInRaw =
      process.env.COGNITO_REDIRECT_SIGN_IN_URLS ??
      "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html";
    const cognitoRedirectSignOutRaw =
      process.env.COGNITO_REDIRECT_SIGN_OUT_URLS ??
      "https://www.shwsh.co.uk/experiments/aivfx/,https://www.shwsh.co.uk/experiments/aivfx/api-test.html,https://shwsh.co.uk/experiments/aivfx/,https://shwsh.co.uk/experiments/aivfx/api-test.html,http://localhost:5173/,http://localhost:5173/api-test.html";
    const cognitoRedirectSignInUrls = cognitoRedirectSignInRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const cognitoRedirectSignOutUrls = cognitoRedirectSignOutRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const allowedOriginsRaw =
      process.env.ALLOWED_WEB_ORIGINS ??
      "https://www.shwsh.co.uk,https://shwsh.co.uk,https://s3.eu-west-2.amazonaws.com";
    const allowedOrigins = allowedOriginsRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (manageAppCloudFront && webBucketOverride) {
      throw new Error("MANAGE_APP_CLOUDFRONT=true cannot be combined with WEB_BUCKET_OVERRIDE");
    }

    const webBucket: s3.IBucket = webBucketOverride
      ? s3.Bucket.fromBucketName(this, "WebBucketImported", webBucketOverride)
      : new s3.Bucket(this, "WebBucket", {
          encryption: s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          versioned: true,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
          autoDeleteObjects: false,
        });

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 300,
        },
      ],
    });

    const metadataBucket = new s3.Bucket(this, "MetadataBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const distribution = manageAppCloudFront
      ? new cloudfront.Distribution(this, "WebDistribution", {
          defaultBehavior: {
            origin: S3BucketOrigin.withOriginAccessControl(webBucket),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          },
          defaultRootObject: "index.html",
          errorResponses: [
            { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.seconds(0) },
            { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.seconds(0) },
          ],
          minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
        })
      : undefined;

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${appName}-users`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        callbackUrls: cognitoRedirectSignInUrls,
        logoutUrls: cognitoRedirectSignOutUrls,
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    const userPoolDomain = userPool.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: `${appName}-${this.account}-${this.region}`.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 63),
      },
    });
    const cognitoHostedUiDomain = `${userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`;

    const apiKeysSecret = new secretsmanager.Secret(this, "ApiKeysSecret", {
      secretName: `${appName}/external-api-keys`,
      secretObjectValue: {
        GEMINI_API_KEY: cdk.SecretValue.unsafePlainText("SET_ME"),
        LUMA_API_KEY: cdk.SecretValue.unsafePlainText("SET_ME"),
      },
    });

    const dlq = new sqs.Queue(this, "JobsDLQ", {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const jobsQueue = new sqs.Queue(this, "JobsQueue", {
      visibilityTimeout: cdk.Duration.minutes(30),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: dlq,
      },
    });

    const backendCodePath = `${__dirname}/../../backend`;

    const defaultFfmpegLayerArn = `arn:aws:lambda:${this.region}:${this.account}:layer:ffmpeg-mini-arm64-python39:1`;
    const configuredFfmpegLayerArn = process.env.FFMPEG_LAYER_ARN?.trim();
    const layerArns = [configuredFfmpegLayerArn || defaultFfmpegLayerArn].filter((arn): arn is string => !!arn);
    const externalLayers = layerArns.map((arn, index) =>
      lambda.LayerVersion.fromLayerVersionArn(this, `ExternalLayer${index}`, arn),
    );

    const apiFn = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.PYTHON_3_10,
      architecture: lambda.Architecture.ARM_64,
      handler: "src/api_handler.handler",
      code: lambda.Code.fromAsset(backendCodePath, {
        ignoreMode: cdk.IgnoreMode.GLOB,
        exclude: ["tests", "__pycache__", ".pytest_cache", "*.pyc"],
      }),
      timeout: cdk.Duration.seconds(29),
      memorySize: 2048,
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        METADATA_BUCKET: metadataBucket.bucketName,
        JOBS_QUEUE_URL: jobsQueue.queueUrl,
        SECRETS_ARN: apiKeysSecret.secretArn,
        CORS_ALLOWED_ORIGINS: allowedOrigins.join(","),
        MAX_UPLOAD_BYTES: String(2 * 1024 * 1024 * 1024),
        MAX_PROMPT_CHARS: "2000",
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: externalLayers,
    });

    const workerFn = new lambda.Function(this, "WorkerFunction", {
      runtime: lambda.Runtime.PYTHON_3_10,
      architecture: lambda.Architecture.ARM_64,
      handler: "src/worker_handler.handler",
      code: lambda.Code.fromAsset(backendCodePath, {
        ignoreMode: cdk.IgnoreMode.GLOB,
        exclude: ["tests", "__pycache__", ".pytest_cache", "*.pyc"],
      }),
      timeout: cdk.Duration.minutes(15),
      memorySize: 10240,
      ephemeralStorageSize: cdk.Size.gibibytes(10),
      environment: {
        ASSETS_BUCKET: assetsBucket.bucketName,
        METADATA_BUCKET: metadataBucket.bucketName,
        JOBS_QUEUE_URL: jobsQueue.queueUrl,
        SECRETS_ARN: apiKeysSecret.secretArn,
        CORS_ALLOWED_ORIGINS: allowedOrigins.join(","),
        MAX_PROMPT_CHARS: "2000",
      },
      tracing: lambda.Tracing.ACTIVE,
      layers: externalLayers,
    });

    workerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(jobsQueue, {
        batchSize: 1,
        maxConcurrency: 4,
      }),
    );

    jobsQueue.grantSendMessages(apiFn);
    jobsQueue.grantSendMessages(workerFn);
    jobsQueue.grantConsumeMessages(workerFn);

    assetsBucket.grantReadWrite(apiFn);
    assetsBucket.grantReadWrite(workerFn);
    metadataBucket.grantReadWrite(apiFn);
    metadataBucket.grantReadWrite(workerFn);
    apiKeysSecret.grantRead(apiFn);
    apiKeysSecret.grantRead(workerFn);

    const integration = new apigwv2Integrations.HttpLambdaIntegration("ApiIntegration", apiFn);
    const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer(
      "CognitoJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    );

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      createDefaultStage: false,
      corsPreflight: {
        allowCredentials: true,
        allowHeaders: ["authorization", "content-type", "x-admin-pin"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: allowedOrigins,
      },
    });

    new apigwv2.CfnStage(this, "DefaultStage", {
      apiId: httpApi.apiId,
      stageName: "$default",
      autoDeploy: true,
      defaultRouteSettings: {
        throttlingBurstLimit: 30,
        throttlingRateLimit: 10,
      },
    });

    httpApi.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration,
    });

    httpApi.addRoutes({
      path: "/",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
      authorizer: jwtAuthorizer,
    });

    new cdk.CfnOutput(this, "WebUrl", {
      value: distribution ? `https://${distribution.distributionDomainName}` : webPublicBaseUrl,
      description: distribution ? "CloudFront URL for static web app" : "External/public web URL",
    });

    new cdk.CfnOutput(this, "WebBucketName", {
      value: webBucket.bucketName,
    });

    new cdk.CfnOutput(this, "CloudFrontDistributionId", {
      value: distribution?.distributionId ?? "",
    });

    new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
      description: "HTTP API endpoint",
    });

    new cdk.CfnOutput(this, "CognitoUserPoolId", {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, "CognitoUserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, "CognitoDomain", {
      value: cognitoHostedUiDomain,
    });

    new cdk.CfnOutput(this, "AssetsBucketName", {
      value: assetsBucket.bucketName,
    });

    new cdk.CfnOutput(this, "MetadataBucketName", {
      value: metadataBucket.bucketName,
    });

    new cdk.CfnOutput(this, "SecretsArn", {
      value: apiKeysSecret.secretArn,
    });
  }
}
