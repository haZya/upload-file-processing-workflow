# File Processing CDK App

AWS CDK TypeScript app for secure file uploads and post-upload processing.

This project provisions the infrastructure and Lambda handlers for a workflow that:

- accepts uploads through presigned S3 posts
- stages files in a private S3 bucket
- waits for GuardDuty malware scan results
- validates and processes uploaded content
- stores final assets in a separate upload bucket
- persists upload metadata in DynamoDB
- emits upload status updates over a WebSocket channel

## Architecture Overview

The CDK app wires together these stacks:

- `StorageStack` - staging bucket, final upload bucket, and CloudFront distribution
- `DatabaseStack` - DynamoDB tables for uploads and upload relationships
- `GuardDutyStack` - malware protection for the staging bucket
- `WebSocketStack` - WebSocket API, authorizer, connection handler, and connections table
- `UploadProcessingStack` - EventBridge rules, Step Functions workflow, upload Lambdas, and status fan-out

The app entrypoint is `bin/app.ts`.

## Upload Flow

1. A client requests a presigned POST and uploads a file to the staging bucket.
2. S3 object creation triggers upload registration.
3. GuardDuty publishes the malware scan result.
4. A Step Functions workflow validates the file and branches on the scan result.
5. Valid files are copied to the final upload bucket, optionally transformed, and enriched with metadata.
6. Upload status is written to DynamoDB and published through the WebSocket channel.

## Project Structure

- `bin/` - CDK app bootstrap
- `lib/` - infrastructure stacks
- `lambda/upload/` - upload and processing handlers
- `lambda/websocket/` - WebSocket auth and connection handlers
- `test/` - Jest tests

## Prerequisites

- Node.js version compatible with the local toolchain and Lambda `NODEJS_22_X`
- npm
- AWS credentials configured for the target account and region
- AWS CDK CLI available through `npx cdk` or a global install

Install dependencies:

```bash
npm install
```

## Useful Commands

- `npm run build` - run the TypeScript typecheck build (`tsc --noEmit`)
- `npm run watch` - run TypeScript in watch mode
- `npm test` - run Jest tests
- `npx cdk synth` - synthesize the CloudFormation templates
- `npx cdk diff` - compare deployed stacks with local changes
- `npx cdk deploy` - deploy the stacks to your configured AWS account

## Notes

- Lambda source lives in TypeScript; prefer editing `.ts` files instead of generated output.
- `npm run build` is a typecheck-only build and does not emit compiled artifacts.
- The staging and upload buckets are private and the final upload bucket is fronted by CloudFront.
- Image processing uses `sharp` during the upload workflow.
