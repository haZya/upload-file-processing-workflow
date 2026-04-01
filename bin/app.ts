#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { GuardDutyStack } from '../lib/guard-duty-stack';
import { StorageStack } from '../lib/storage-stack';
import { UploadProcessingStack } from '../lib/upload-processing-stack';
import { WebSocketStack } from '../lib/websocket-stack';

const app = new App();

const storageStack = new StorageStack(app, "Storage")

const databaseStack = new DatabaseStack(app, "Database")

const guardDutyStack = new GuardDutyStack(app, "GuardDuty", { stagingUploadBucket: storageStack.stagingUploadBucket });
guardDutyStack.addDependency(storageStack)

const webSocketStack = new WebSocketStack(app, "WebSocket", {})

const uploadProcessingStack = new UploadProcessingStack(app, 'UploadProcessing', {
  stagingUploadBucket: storageStack.stagingUploadBucket,
  uploadBucket: storageStack.uploadBucket,
  uploadsTable: databaseStack.uploadsTable,
  uploadRelationsTable: databaseStack.uploadRelationsTable,
  webSocket: webSocketStack
});
uploadProcessingStack.addDependency(storageStack);
uploadProcessingStack.addDependency(databaseStack);
uploadProcessingStack.addDependency(webSocketStack)
