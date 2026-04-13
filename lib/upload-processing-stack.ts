import type { StackProps } from "aws-cdk-lib";
import { Duration, Stack } from "aws-cdk-lib";
import { IWebSocketApi, IWebSocketStage, WebSocketApi } from "aws-cdk-lib/aws-apigatewayv2";
import { ITableV2 } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { LambdaFunction, SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import {
    Choice,
    Condition,
    DefinitionBody,
    Errors,
    Fail,
    JsonPath,
    LogLevel,
    Parallel,
    Pass,
    Result,
    StateMachine,
    StateMachineType,
    Succeed,
    TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import {
    CallAwsService,
    EventBridgePutEvents,
    LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";

interface UploadProcessingStackProps extends StackProps {
  readonly stagingUploadBucket: IBucket;
  readonly uploadBucket: IBucket;
  readonly uploadsTable: ITableV2;
  readonly uploadRelationsTable: ITableV2;
  readonly webSocket: {
    readonly connectionsTable: ITableV2;
    readonly stage: IWebSocketStage;
    readonly api: IWebSocketApi;
  }
}

export class UploadProcessingStack extends Stack {
  constructor(scope: Construct, id: string, props: UploadProcessingStackProps) {
    super(scope, id, props);

    const { stagingUploadBucket, uploadBucket, uploadsTable, uploadRelationsTable, webSocket } = props;

    const fileProcessingEventsBus = new EventBus(this, "FileProcessingEventsBus");

    const registerUploadLambda = this.createUploadLambda("RegisterUploadHandler", {
      entry: "lambda/upload/register-upload.ts",
      uploadsTable,
      uploadRelationsTable,
      initialPolicy: [
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [stagingUploadBucket.arnForObjects("*")],
        }),
      ],
    });

    const generatePresignedPostLambda = this.createUploadLambda("GeneratePresignedPostHandler", {
      entry: "lambda/upload/generate-presigned-post.ts",
      uploadsTable,
      uploadRelationsTable,
      environment: {
        STAGING_UPLOAD_BUCKET_NAME: stagingUploadBucket.bucketName,
      },
    });

    uploadsTable.grantReadWriteData(registerUploadLambda);
    stagingUploadBucket.grantPut(generatePresignedPostLambda);

    const s3ObjectCreatedDeliveryDlq = new Queue(this, "S3ObjectCreatedEventBridgeDLQ", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    new Rule(this, "S3ObjectCreatedRule", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [stagingUploadBucket.bucketName],
          },
        },
      },
      targets: [
        new LambdaFunction(registerUploadLambda, {
          event: RuleTargetInput.fromObject({
            bucket: EventField.fromPath("$.detail.bucket.name"),
            key: EventField.fromPath("$.detail.object.key"),
          }),
          maxEventAge: Duration.minutes(3),
          retryAttempts: 4,
          deadLetterQueue: s3ObjectCreatedDeliveryDlq,
        }),
      ],
    });


    const validateFileLambda = this.createUploadLambda("ValidateFileHandler", {
      entry: "lambda/upload/validate.ts",
      uploadsTable,
      uploadRelationsTable,
      initialPolicy: [
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [stagingUploadBucket.arnForObjects("*")],
        }),
      ],
    });

    uploadsTable.grantReadWriteData(validateFileLambda);

    const resolveFinalKeyLambda = new NodejsFunction(this, "ResolveFinalKeyHandler", {
      entry: "lambda/upload/resolve-final-key.ts",
      runtime: Runtime.NODEJS_22_X,
    });

    const transformImageLambda = new NodejsFunction(this, "TransformImageHandler", {
      entry: "lambda/upload/transform-image.ts",
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(20),
      memorySize: 512,
      environment: {
        UPLOAD_BUCKET: uploadBucket.bucketName,
      },
      bundling: {
        nodeModules: ["sharp"],
        environment: {
          NPM_CONFIG_BIN_LINKS: "false",
        },
      },
      initialPolicy: [
        new PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [uploadBucket.arnForObjects("*")],
        }),
      ],
    });

    const addMetadataLambda = this.createUploadLambda("AddMetadataHandler", {
      entry: "lambda/upload/add-metadata.ts",
      uploadsTable,
      uploadRelationsTable,
    });

    uploadsTable.grantReadWriteData(addMetadataLambda);

    const updateUploadStatusLambda = this.createUploadLambda("UpdateUploadStatusHandler", {
      entry: "lambda/upload/update-status.ts",
      uploadsTable,
      uploadRelationsTable,
    });

    uploadsTable.grantReadWriteData(updateUploadStatusLambda);
    uploadRelationsTable.grantReadWriteData(updateUploadStatusLambda);

    const cleanupReplacedUploadLambda = this.createUploadLambda("CleanupReplacedUploadHandler", {
      entry: "lambda/upload/cleanup-replaced-upload.ts",
      uploadsTable,
      uploadRelationsTable,
      environment: {
        UPLOAD_BUCKET: uploadBucket.bucketName,
      },
    });

    uploadsTable.grantReadWriteData(cleanupReplacedUploadLambda);
    uploadBucket.grantDelete(cleanupReplacedUploadLambda);

    const s3RetryErrors = [
      "S3.InternalError",
      "S3.ServiceUnavailable",
      "ThrottlingException",
      "States.ServiceException",
      "States.ServiceUnavailable",
      Errors.TASKS_FAILED,
      Errors.TIMEOUT,
    ];

    const lambdaRetryErrors = [
      "Lambda.ServiceException",
      "Lambda.AWSLambdaException",
      "Lambda.SdkClientException",
      "States.TaskFailed",
      Errors.TIMEOUT,
    ];

    const eventBridgeRetryErrors = [
      "EventBridge.InternalException",
      "EventBridge.ThrottlingException",
      "States.ServiceException",
      "States.ServiceUnavailable",
      Errors.TASKS_FAILED,
      Errors.TIMEOUT,
    ];

    const validateFileTask = this.createLambdaTask("ValidateFileTask", validateFileLambda);
    const resolveFinalKeyTask = this.createLambdaTask("ResolveFinalKeyTask", resolveFinalKeyLambda);
    const transformImageTask = this.createLambdaTask("TransformImageTask", transformImageLambda);
    const addMetadataTask = this.createLambdaTask("AddMetadataTask", addMetadataLambda);
    const updateUploadStatusSuccessTask = this.createLambdaTask("UpdateUploadStatusSuccessTask", updateUploadStatusLambda);
    const updateUploadStatusFailureTask = this.createLambdaTask("UpdateUploadStatusFailureTask", updateUploadStatusLambda);
    const cleanupReplacedUploadTask = this.createLambdaTask("CleanupReplacedUploadTask", cleanupReplacedUploadLambda);

    const copyToUploadBucketTask = new CallAwsService(this, "CopyToUploadBucket", {
      service: "s3",
      action: "copyObject",
      parameters: {
        CopySource: JsonPath.format("{}/{}", stagingUploadBucket.bucketName, JsonPath.stringAt("$.key")),
        Bucket: uploadBucket.bucketName,
        Key: JsonPath.stringAt("$.finalKey"),
        MetadataDirective: "REPLACE",
        ContentType: JsonPath.stringAt("$.mime"),
        TaggingDirective: "REPLACE",
      },
      iamAction: "s3:PutObject",
      iamResources: [uploadBucket.arnForObjects("*")],
      additionalIamStatements: [
        new PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [stagingUploadBucket.arnForObjects("*")],
        }),
      ],
      resultPath: "$.s3CopyResult",
    });

    const deleteStagingObjectOnCopySuccessTask = new CallAwsService(this, "DeleteStagingObjectOnCopySuccess", {
      service: "s3",
      action: "deleteObject",
      parameters: {
        Bucket: stagingUploadBucket.bucketName,
        Key: JsonPath.stringAt("$.key"),
      },
      iamResources: [stagingUploadBucket.arnForObjects("*")],
      resultPath: JsonPath.DISCARD,
    });

    const deleteInvalidStagingObjectTask = new CallAwsService(this, "DeleteInvalidStagingObject", {
      service: "s3",
      action: "deleteObject",
      parameters: {
        Bucket: stagingUploadBucket.bucketName,
        Key: JsonPath.stringAt("$.key"),
      },
      iamResources: [stagingUploadBucket.arnForObjects("*")],
      resultPath: JsonPath.DISCARD,
    });

    const deleteThreatStagingObjectTask = new CallAwsService(this, "DeleteThreatStagingObject", {
      service: "s3",
      action: "deleteObject",
      parameters: {
        Bucket: stagingUploadBucket.bucketName,
        Key: JsonPath.stringAt("$.key"),
      },
      iamResources: [stagingUploadBucket.arnForObjects("*")],
      resultPath: JsonPath.DISCARD,
    });

    [
      copyToUploadBucketTask,
      deleteStagingObjectOnCopySuccessTask,
      deleteInvalidStagingObjectTask,
      deleteThreatStagingObjectTask,
    ].forEach(task => this.addServiceRetry(task, s3RetryErrors));

    [
      validateFileTask,
      resolveFinalKeyTask,
      transformImageTask,
      addMetadataTask,
      updateUploadStatusSuccessTask,
      updateUploadStatusFailureTask,
      cleanupReplacedUploadTask,
    ].forEach(task => this.addServiceRetry(task, lambdaRetryErrors));

    const uploadStatusEmitSuccess = this.createUploadStatusEmitTask("UploadStatusEmitSuccess", fileProcessingEventsBus);
    const uploadStatusEmitFailureOnCleanup = this.createUploadStatusEmitTask("UploadStatusEmitFailureOnCleanup", fileProcessingEventsBus);
    const uploadStatusEmitFailureOnCatch = this.createUploadStatusEmitTask("UploadStatusEmitFailureOnCatch", fileProcessingEventsBus);

    [
      uploadStatusEmitSuccess,
      uploadStatusEmitFailureOnCleanup,
      uploadStatusEmitFailureOnCatch,
    ].forEach(task => this.addServiceRetry(task, eventBridgeRetryErrors));

    const workflowFailState = new Fail(this, "WorkflowFailureError", {
      errorPath: "$.status.name",
      causePath: "$.status.message",
    });

    const markValidationFailedTask = this.createHandledStatusTask(
      "MarkValidationFailed",
      "VALIDATION_FAILED",
      "File rejected due to invalid content",
    );
    const markThreatDetectedTask = this.createHandledStatusTask(
      "MarkThreatDetected",
      "THREAT_DETECTED",
      "File rejected due to malware scan result",
    );

    updateUploadStatusSuccessTask.addCatch(this.createFailureTerminal(
      "StatusUpdateFailedOnSuccess",
      "STATUS_UPDATE_FAILED",
      "Failed to persist the upload status",
      fileProcessingEventsBus,
    ), {
      errors: [Errors.ALL],
      resultPath: "$.error",
    });

    updateUploadStatusFailureTask.addCatch(this.createFailureTerminal(
      "StatusUpdateFailedOnFailure",
      "STATUS_UPDATE_FAILED",
      "Failed to persist the upload status",
      fileProcessingEventsBus,
    ), {
      errors: [Errors.ALL],
      resultPath: "$.error",
    });

    const updateUploadStatusCleanupFailureTask = this.createLambdaTask("UpdateUploadStatusCleanupFailureTask", updateUploadStatusLambda);

    this.addServiceRetry(updateUploadStatusCleanupFailureTask, lambdaRetryErrors);

    cleanupReplacedUploadTask.addCatch(
      this.createHandledStatusTask(
        "MarkCleanupFailed",
        "CLEANUP_FAILED",
        "File processed but cleanup of the replaced upload failed",
      )
        .next(updateUploadStatusCleanupFailureTask)
        .next(uploadStatusEmitFailureOnCleanup)
        .next(workflowFailState),
      {
        errors: [Errors.ALL],
        resultPath: "$.error",
      },
    );

    const workflowSuccessState = new Succeed(this, "FileUploadSuccess");
    const skipCleanupTask = new Pass(this, "SkipCleanupForNonCompleteStatus");
    const postProcessingFlow = updateUploadStatusSuccessTask
      .next(
        new Choice(this, "ShouldCleanupReplacedUpload")
          .when(Condition.stringEquals("$.status.name", "UPLOAD_COMPLETE"), cleanupReplacedUploadTask)
          .otherwise(skipCleanupTask)
          .afterwards(),
      )
      .next(uploadStatusEmitSuccess)
      .next(
        new Choice(this, "IsWorkflowFailure")
          .when(Condition.stringEquals("$.status.name", "UPLOAD_FAILED"), workflowFailState)
          .when(Condition.stringEquals("$.status.name", "CLEANUP_FAILED"), workflowFailState)
          .when(Condition.stringEquals("$.status.name", "STATUS_UPDATE_FAILED"), workflowFailState)
          .otherwise(workflowSuccessState),
      );

    const transformAndDelete = new Parallel(this, "TransformAndDeleteStagingFile", {
      outputPath: "$.[0]",
    });

    transformAndDelete.branch(
      new Choice(this, "IsImage")
        .when(Condition.stringMatches("$.mime", "image/*"), transformImageTask)
        .otherwise(new Pass(this, "SkipTransformForNonImage"))
        .afterwards()
        .next(addMetadataTask),
    );

    transformAndDelete.branch(deleteStagingObjectOnCopySuccessTask);

    const coreWorkflow = new Choice(this, "ScanResultOK")
      .when(
        Condition.stringEquals("$.scanResultStatus", "NO_THREATS_FOUND"),
        validateFileTask
          .next(
            new Choice(this, "IsFileValid")
              .when(Condition.booleanEquals("$.isValid", true), resolveFinalKeyTask.next(copyToUploadBucketTask).next(transformAndDelete))
              .otherwise(deleteInvalidStagingObjectTask.next(markValidationFailedTask)),
          ),
      )
      .otherwise(deleteThreatStagingObjectTask.next(markThreatDetectedTask));

    const definition = new Parallel(this, "MainWorkflowGroup", {
      outputPath: "$.[0]",
    })
      .branch(coreWorkflow)
      .addCatch(updateUploadStatusFailureTask.next(uploadStatusEmitFailureOnCatch).next(workflowFailState), {
        errors: [Errors.ALL],
        resultPath: "$.error",
      })
      .next(postProcessingFlow);

    const logGroup = new LogGroup(this, "FileUploadStateMachineLogs", {
      retention: RetentionDays.ONE_WEEK,
    });

    const stateMachine = new StateMachine(this, "FileUploadStateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(5),
      stateMachineType: StateMachineType.EXPRESS,
      logs: {
        destination: logGroup,
        level: LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    const guardDutyResultDeliveryDlq = new Queue(this, "GuardDutyResultEventBridgeDLQ", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    new Rule(this, "GuardDutyScanResultRule", {
      eventPattern: {
        source: ["aws.guardduty"],
        detailType: ["GuardDuty Malware Protection Object Scan Result"],
        detail: {
          resourceType: ["S3_OBJECT"],
          s3ObjectDetails: {
            bucketName: [stagingUploadBucket.bucketName],
          },
        },
      },
      targets: [
        new SfnStateMachine(stateMachine, {
          input: RuleTargetInput.fromObject({
            bucket: EventField.fromPath("$.detail.s3ObjectDetails.bucketName"),
            key: EventField.fromPath("$.detail.s3ObjectDetails.objectKey"),
            scanStatus: EventField.fromPath("$.detail.scanStatus"),
            scanResultStatus: EventField.fromPath("$.detail.scanResultDetails.scanResultStatus"),
            threats: EventField.fromPath("$.detail.scanResultDetails.threats"),
          }),
          retryAttempts: 5,
          deadLetterQueue: guardDutyResultDeliveryDlq,
        }),
      ],
    });

    const emitUploadStatusLambda = new NodejsFunction(this, "EmitUploadStatusHandler", {
      entry: "lambda/upload/emit-upload-status.ts",
      runtime: Runtime.NODEJS_22_X,
      environment: {
        CONNECTIONS_TABLE_NAME: webSocket.connectionsTable.tableName,
        WEBSOCKET_API_ENDPOINT: webSocket.stage.callbackUrl,
      },
    });

    webSocket.connectionsTable.grantReadData(emitUploadStatusLambda);
    (webSocket.api as WebSocketApi).grantManageConnections(emitUploadStatusLambda);

    const uploadStatusChangedDeliveryDlq = new Queue(this, "UploadStatusChangedEventBridgeDLQ", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    new Rule(this, "UploadStatusChangedRule", {
      eventBus: fileProcessingEventsBus,
      eventPattern: {
        detailType: ["UploadStatusChanged"],
      },
      targets: [
        new LambdaFunction(emitUploadStatusLambda, {
          event: RuleTargetInput.fromEventPath("$.detail"),
          retryAttempts: 5,
          deadLetterQueue: uploadStatusChangedDeliveryDlq,
        }),
      ],
    });
  }

  private createUploadLambda(
    id: string,
    props: {
      entry: string;
      uploadsTable: ITableV2;
      uploadRelationsTable: ITableV2;
      environment?: Record<string, string>;
      initialPolicy?: PolicyStatement[];
    },
  ) {
    return new NodejsFunction(this, id, {
      entry: props.entry,
      runtime: Runtime.NODEJS_22_X,
      environment: {
        UPLOADS_TABLE_NAME: props.uploadsTable.tableName,
        UPLOAD_RELATIONS_TABLE_NAME: props.uploadRelationsTable.tableName,
        ...props.environment,
      },
      initialPolicy: props.initialPolicy,
    });
  }

  private createLambdaTask(id: string, fn: NodejsFunction) {
    return new LambdaInvoke(this, id, {
      lambdaFunction: fn,
      payloadResponseOnly: true,
      retryOnServiceExceptions: true,
    });
  }

  private addServiceRetry(task: CallAwsService | LambdaInvoke | EventBridgePutEvents, errors: string[]) {
    task.addRetry({
      errors,
      interval: Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });
  }

  private createUploadStatusEmitTask(id: string, uploadStatusBus: EventBus) {
    return new EventBridgePutEvents(this, id, {
      entries: [
        {
          eventBus: uploadStatusBus,
          detailType: "UploadStatusChanged",
          detail: TaskInput.fromJsonPathAt("$"),
          source: "com.file-processing.upload",
        },
      ],
      resultPath: "$.eventBridgeResult",
    });
  }

  private createHandledStatusTask(id: string, name: string, message: string) {
    return new Pass(this, id, {
      result: Result.fromObject({
        isSuccess: false,
        name,
        message,
      }),
      resultPath: "$.handledStatus",
    });
  }

  private createFailureTerminal(idPrefix: string, statusName: string, message: string, uploadStatusBus: EventBus) {
    const markFailure = this.createHandledStatusTask(`Mark${idPrefix}`, statusName, message);
    const emitFailure = this.createUploadStatusEmitTask(`Emit${idPrefix}`, uploadStatusBus);
    const failState = new Fail(this, `Fail${idPrefix}`, {
      errorPath: "$.handledStatus.name",
      causePath: "$.handledStatus.message",
    });

    return markFailure.next(emitFailure).next(failState);
  }
}
