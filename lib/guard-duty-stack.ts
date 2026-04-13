import type { IBucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

import { Stack, StackProps } from "aws-cdk-lib";
import { CfnMalwareProtectionPlan } from "aws-cdk-lib/aws-guardduty";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";

interface GuardDutyStackProps extends StackProps {
    readonly stagingUploadBucket: IBucket;
}

export class GuardDutyStack extends Stack {
    constructor(scope: Construct, id: string, props: GuardDutyStackProps) {
        super(scope, id, props);

        const { stagingUploadBucket } = props

        const role = new Role(this, "GuardDutyMalwareScanRole", {
            assumedBy: new ServicePrincipal("malware-protection-plan.guardduty.amazonaws.com"),
        });

        const policy = new Policy(this, "GuardDutyMalwareProtectionRolePolicy", {
            policyName: "GuardDutyMalwareProtectionRolePolicy",
            statements: [
                new PolicyStatement({
                    sid: "AllowManagedRuleToSendS3EventsToGuardDuty",
                    actions: ["events:PutRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets"],
                    resources: [
                        `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
                    ],
                    conditions: {
                        StringLike: {
                            "events:ManagedBy": "malware-protection-plan.guardduty.amazonaws.com",
                        },
                    },
                }),
                new PolicyStatement({
                    sid: "AllowGuardDutyToMonitorEventBridgeManagedRule",
                    actions: ["events:DescribeRule", "events:ListTargetsByRule"],
                    resources: [
                        `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`,
                    ],
                }),
                new PolicyStatement({
                    sid: "AllowPostScanTag",
                    actions: ["s3:PutObjectTagging", "s3:GetObjectTagging", "s3:PutObjectVersionTagging", "s3:GetObjectVersionTagging"],
                    resources: [`${stagingUploadBucket.bucketArn}/*`],
                }),
                new PolicyStatement({
                    sid: "AllowEnableS3EventBridgeEvents",
                    actions: ["s3:PutBucketNotification", "s3:GetBucketNotification"],
                    resources: [stagingUploadBucket.bucketArn],
                }),
                new PolicyStatement({
                    sid: "AllowPutValidationObject",
                    actions: ["s3:PutObject"],
                    resources: [`${stagingUploadBucket.bucketArn}/malware-protection-resource-validation-object`],
                }),
                new PolicyStatement({
                    sid: "AllowCheckBucketOwnership",
                    actions: ["s3:ListBucket", "s3:GetBucketLocation"],
                    resources: [stagingUploadBucket.bucketArn],
                }),
                new PolicyStatement({
                    sid: "AllowMalwareScan",
                    actions: ["s3:GetObject", "s3:GetObjectVersion"],
                    resources: [`${stagingUploadBucket.bucketArn}/*`],
                }),
            ],
        });

        if (stagingUploadBucket.encryptionKey) {
            policy.addStatements(new PolicyStatement({
                sid: "AllowDecryptForMalwareScan",
                actions: ["kms:GenerateDataKey", "kms:Decrypt"],
                resources: [
                    `${stagingUploadBucket.encryptionKey?.keyArn}`,
                ],
                conditions: {
                    StringLike: {
                        "kms:ViaService": `s3.${this.region}.amazonaws.com`,
                    },
                },
            }));
        }

        policy.attachToRole(role);

        const plan = new CfnMalwareProtectionPlan(this, "S3MalwareProtectionPlan", {
            role: role.roleArn,
            protectedResource: {
                s3Bucket: {
                    bucketName: stagingUploadBucket.bucketName,
                },
            },
            actions: {
                tagging: { status: "ENABLED" },
            },
        });

        // Ensure the IAM role/policies are in place before the plan
        plan.node.addDependency(policy);
    }
}