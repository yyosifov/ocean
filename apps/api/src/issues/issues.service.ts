import { IssueStatusDetailed, V2FixIssueDetails, V2Tag } from '@logicstar/logic-tasks-types/golden-schema';
import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException, Scope } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AgentProcessingStatus,
  AgentResultStatus,
  BugFindingRule,
  Integration,
  IntegrationProvider,
  IntegrationType,
  Issue,
  Organization,
  Prisma,
  Commit as PrismaCommit,
  IssueDetails as PrismaIssueDetails,
  Project,
  ProjectIntegrationMapping,
  Task,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { AnalyticsService } from '../analytics/analytics.service';
import { IUserInfo } from '../auth/types';
import { CloudStorageService } from '../cloud-storage/cloud-storage.service';
import { LogicTasksCommunicationService } from '../cloud-storage/logic-tasks-communication.service';
import { BaseSlackService, BotTokenAuthStrategy } from '../common/services/base-slack';
import { RequestContextService } from '../common/services/request-context';
import { getIssueDetailsStats } from '../common/stats/issue-stats';
import {
  AppPayload,
  AppRepo,
  AppReviewSession,
  AppReviewThread,
  ImproveFixPayload,
  ProjectManagementIntegrationsMapping,
  StorageCleanupPayload,
  TaskTypes,
} from '../common/types';
import { UrlService } from '../common/url/url.service';
import { pick } from '../common/utils';
import { ISSUE_EVENTS, STATS_EVENTS } from '../events/event-constants';
import { SseService } from '../events/sse.service';
import { AsanaService } from '../integrations/asana/asana.service';
import { AsanaTask } from '../integrations/asana/types/asana-api-types';
import { AtlassianService } from '../integrations/atlassian/atlassian.service';
import { JiraIssue } from '../integrations/atlassian/types';
import { GithubIssuesService } from '../integrations/github/github-issues.service';
import { GitHubIssue } from '../integrations/github/types/github-issues-api-types';
import { GitlabIssuesService } from '../integrations/gitlab/gitlab-issues.service';
import { GitLabIssue } from '../integrations/gitlab/types/gitlab-issues-api-types';
import { LinearIssuesService } from '../integrations/linear/linear-issues.service';
import { ILinearIssue } from '../integrations/linear/types';
import { NotionService } from '../integrations/notion/notion.service';
import { NotionIssue } from '../integrations/notion/types';
import { TrelloService } from '../integrations/trello/trello.service';
import { TrelloComment, TrelloIssue } from '../integrations/trello/types';
import { PrismaService } from '../prisma/prisma.service';
import { toResponseCommit } from '../projects/commit.utils';
import { buildIssueTaskPayload } from '../tasks/task-builders';
import { TasksService } from '../tasks/tasks.service';
import { TaskStatus } from '../tasks/types';
import { PrismaIssueWithRelations, toIIssue } from './issues.utils';
import { extractStorageDirectories, getAgentProcessingStatus, getAgentResultStatus, isValidatedFix } from './issues-utils';
import { ReviewSessionsService } from './review-sessions.service';
import {
  AggregatedIssueStatus,
  CreateFeedbackDto,
  CreateIssueCommentsDto,
  CreateIssueDto,
  IFeedback,
  IIssue,
  IIssueComment,
  IIssueDetails,
  IIssueDetailsListItem,
  IIssueListItem,
  IIssueRevision,
  IReviewComment,
  IReviewSession,
  IReviewSessionThread,
  IReviewThread,
  ISyncIssuesResponse,
  IssueCommentSyncDto,
  IssueSyncResponseDto,
  ITag,
  ReviewSessionState,
  UpdateIssueDetailsDto,
  UpdateIssueDto,
} from './types';

type IssueDetails = V2FixIssueDetails;
type Tag = V2Tag;

export type IssueFilters = {
  isArchived?: boolean;
};

@Injectable({ scope: Scope.REQUEST })
export class IssuesService {
  private readonly logger = new Logger(IssuesService.name);
  private readonly baseSlackService: BaseSlackService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logicTasksCommunicationService: LogicTasksCommunicationService,
    private readonly cloudStorageService: CloudStorageService,
    private readonly asanaService: AsanaService,
    private readonly atlassianService: AtlassianService,
    private readonly trelloService: TrelloService,
    private readonly taskService: TasksService,
    private readonly githubIssuesService: GithubIssuesService,
    private readonly gitlabIssuesService: GitlabIssuesService,
    private readonly linearIssuesService: LinearIssuesService,
    private readonly notionService: NotionService,
    private readonly sseService: SseService,
    private readonly requestContextService: RequestContextService,
    private readonly reviewSessionsService: ReviewSessionsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly analyticsService: AnalyticsService,
    private readonly configService: ConfigService,
    private readonly urlService: UrlService,
  ) {
    const internalSlackBotToken = this.configService.get<string>('INTERNAL_SLACK_BOT_TOKEN') || '';
    this.baseSlackService = new BaseSlackService(new BotTokenAuthStrategy(internalSlackBotToken));
  }

  private async resolveOrganization(project: Project): Promise<Organization> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: project.organizationId },
    });
    if (!organization) {
      throw new NotFoundException(`Organization not found: ${project.organizationId}`);
    }

    return organization;
  }

  private async buildAppRepoPayload(commitId: string): Promise<AppRepo> {
    const commit = await this.prisma.commit.findUnique({
      where: { id: commitId },
      include: {
        repository: true,
      },
    });

    if (!commit) {
      throw new NotFoundException(`Commit not found: ${commitId}`);
    }

    const repo: AppRepo = {
      hash: commit.sha,
      url: commit.repository.url ?? `https://github.com/${commit.repository.owner}/${commit.repository.name}`,
    };

    return repo;
  }

  private async buildAppPayload(issue: Issue, commitId: string): Promise<AppPayload> {
    const issueComments = await this.prisma.issueComment.findMany({
      where: {
        issueId: issue.id,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    const repo: AppRepo = await this.buildAppRepoPayload(commitId);

    const payload = buildIssueTaskPayload(issue, issueComments, repo);
    return payload;
  }

  private buildReviewSessionPayload(reviewSession: IReviewSession, iterationIndex: number): AppReviewSession {
    const threads: AppReviewThread[] =
      reviewSession.sessionThreads?.map((st: IReviewSessionThread) => {
        const t = st.reviewThread;
        return {
          ...pick(t, ['id', 'file', 'startLine', 'endLine', 'side']),
          comments: t.comments.map((c: IReviewComment) => {
            return {
              ...pick(c, ['id', 'message', 'authorId', 'authorRole', 'createdAt', 'updatedAt']),
            };
          }),
        };
      }) ?? [];

    const payload: AppReviewSession = {
      id: reviewSession.id,
      iterationIndex,
      authorId: reviewSession.createdById,
      createdAt: reviewSession.createdAt,
      threads: threads as AppReviewThread[],
    };

    return payload;
  }

  public async createIssueInCloudStorage(project: Project, issue: Issue, commitId: string): Promise<void> {
    try {
      this.logger.log(`Creating issue in cloud storage for project ${project.slug} and issue ${issue.key}`);

      const payload = await this.buildAppPayload(issue, commitId);
      const organization = await this.resolveOrganization(project);
      const task = await this.taskService.createTask({
        type: TaskTypes.FIX_ISSUE,
        payload,
        projectSlug: project.slug,
        orgSlug: organization.slug,
        projectId: project.id,
        organizationId: project.organizationId,
      });

      const cloudStorageIssue = await this.logicTasksCommunicationService.uploadIssueFile(project, organization, issue, task);

      const cloudStorageInfo = {
        fileName: cloudStorageIssue.fileName,
        fullPath: cloudStorageIssue.fullPath,
        type: 'google-cloud-storage',
        timestamp: new Date(),
        taskId: task.id,
      };

      this.logger.log(
        `Updating issue ${issue.id} with commit id ${commitId || 'undefined'} and cloud storage info ${JSON.stringify(cloudStorageInfo)}`,
      );
      await this.prisma.issue.update({
        where: { id: issue.id },
        data: {
          cloudStorageInfo,
          commitId,
          agentProcessingStatus: AgentProcessingStatus.scheduled,
        },
      });

      this.logger.log(`Issue stored in database with id: ${issue.id} and in cloud storage with path: ${cloudStorageInfo.fullPath}`);
    } catch (error) {
      this.logger.error(`Error creating issue in cloud storage for project ${project.slug} and issue ${issue.key}: ${error}`);
      throw new InternalServerErrorException(`Error creating issue in cloud storage for project ${project.slug} and issue ${issue.key}`);
    }
  }

  private async createIssueImproveFixTask(
    project: Project,
    issue: Issue,
    commitId: string,
    reviewSession: IReviewSession,
    iterationIndex: number,
    issueDetails: PrismaIssueDetails,
  ): Promise<void> {
    try {
      this.logger.log(`Creating issue with review session in cloud storage for project ${project.slug} and issue ${issue.key}`);

      const appPayload = await this.buildAppPayload(issue, commitId);
      const reviewSessionPayload = this.buildReviewSessionPayload(reviewSession, iterationIndex);
      const organization = await this.resolveOrganization(project);

      const improveFixPayload: ImproveFixPayload = {
        version: 1,
        repo: appPayload.repo,
        issue: appPayload.issue,
        review: reviewSessionPayload,
        solvedTaskPath: issueDetails.solvedTaskStoragePath ?? 'Missing solved task storage path in the issue details',
      };

      const task = await this.taskService.createTask({
        type: TaskTypes.IMPROVE_FIX,
        payload: improveFixPayload,
        projectSlug: project.slug,
        orgSlug: organization.slug,
        projectId: project.id,
        organizationId: project.organizationId,
      });

      await this.logicTasksCommunicationService.uploadTaskFile(project, organization, task, `${issue.id}_${iterationIndex}`);

      this.logger.log(`Updating issue ${issue.id} with commit id ${commitId || 'undefined'}  and set agent processing status to scheduled`);
      await this.prisma.issue.update({
        where: { id: issue.id },
        data: {
          commitId,
          agentProcessingStatus: AgentProcessingStatus.not_started,
          aggregatedStatus: AggregatedIssueStatus.processing_review,
        },
      });
    } catch (error) {
      this.logger.error(`Error creating issue in redis stream for project ${project.slug} and issue ${issue.key}: ${error}`);
      throw new InternalServerErrorException(`Error creating issue in redis stream for project ${project.slug} and issue ${issue.key}`);
    }
  }

  public async recomputeIssue(projectId: string, issueId: string, force = false): Promise<void> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId, projectId },
      include: {
        details: {
          select: {
            id: true,
            solvedTaskStoragePath: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        repositories: {
          include: {
            latestCommit: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId}`);
    }

    if (issue.isArchived) {
      this.logger.log(`Issue ${issueId} is archived, skipping recomputation`);
      throw new BadRequestException(`Issue ${issueId} is archived`);
    }

    this.logger.log(`Recomputing issue ${issue.key} (${issueId}) in project ${project.slug} (${projectId})`);

    // bug_finder issues: only 'working' blocks recompute (not_started is eligible for processing)
    // Other issues: both 'not_started' and 'working' block recompute (they're queued or processing)
    const isBugFinderIssue = issue.source === 'bug_finder';
    const isWorking = issue.agentProcessingStatus === AgentProcessingStatus.working;
    const isNotStarted = issue.agentProcessingStatus === AgentProcessingStatus.not_started;
    const isAlreadyProcessing = isBugFinderIssue ? isWorking : isNotStarted || isWorking;

    if (!force && isAlreadyProcessing) {
      throw new BadRequestException(`Issue ${issueId} is already in status ${issue.agentProcessingStatus}.`);
    }

    const commitId = project?.repositories[0]?.latestCommit?.id ?? '';
    if (!commitId) {
      this.logger.error(`No commit id found for project ${projectId} in repository ${project?.repositories[0]?.name}`);
    }

    // check if there is a review session for this issue that is not submitted
    const latestIssueDetailsId = issue.details?.[0]?.id;
    const reviewSessions: IReviewSession[] = await this.reviewSessionsService.getReviewSessionsByIssueDetail(latestIssueDetailsId);
    const latestReviewSession = reviewSessions?.at(-1);
    if (latestIssueDetailsId && latestReviewSession && latestReviewSession.state !== ReviewSessionState.submitted) {
      this.logger.log(`Submitting review session for issue ${issue.key} (${issueId}) in project ${project.slug} (${projectId})`);

      // Track analytics event for recompute with review session
      await this.analyticsService.trackEvent(
        {
          event: 'improve_fix',
          properties: {
            issue_id: issueId,
            review_session_id: latestReviewSession.id,
            issue_details_id: latestIssueDetailsId,
            force,
          },
        },
        {
          projectId,
          organizationId: project.organizationId,
        },
      );

      await this.reviewSessionsService.submitReviewSession(latestIssueDetailsId);

      const iterationIndex = issue.details.length;
      const issueDetails = issue.details?.[0];
      await this.createIssueImproveFixTask(project, issue, commitId, latestReviewSession, iterationIndex, issueDetails as PrismaIssueDetails);
    } else {
      await this.createIssueInCloudStorage(project, issue, commitId);
    }
  }

  async createIssues(projectId: string, organizationId: string, issues: CreateIssueDto[], submitToStorage = true): Promise<Issue[]> {
    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
        organizationId,
      },
      include: {
        repositories: {
          include: {
            latestCommit: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found in organization ${organizationId}`);
    }

    const createdIssues: Issue[] = [];
    for (const issue of issues) {
      try {
        const createdIssue = await this.createIssue(projectId, organizationId, issue, submitToStorage);
        if (createdIssue) {
          createdIssues.push(createdIssue);
        }
      } catch (error) {
        this.logger.error(`Error creating issue: ${error}`);
      }
    }
    return createdIssues;
  }

  async createIssue(projectId: string, organizationId: string, createIssueDto: CreateIssueDto, submitToStorage = true): Promise<Issue | null> {
    const user = this.requestContextService.getUser();

    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
        organizationId,
      },
      include: {
        repositories: {
          include: {
            latestCommit: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found in organization ${organizationId}`);
    }

    let key = createIssueDto.key;
    if (!key) {
      key = `${project.slug}-${uuidv4()}`;
    }

    // check if the issue already exists with the same key
    const existingIssue = await this.prisma.issue.findFirst({
      where: {
        key,
        projectId,
        organizationId,
      },
    });

    if (existingIssue) {
      this.logger.error(`Issue with key ${key} already exists in project ${project.slug} for organization ${organizationId}. Skipping creation.`);
      return null;
    }

    this.logger.log(
      `Creating issue with key: ${key} and title: ${createIssueDto.title} in project ${project.slug} for organization ${organizationId}`,
    );

    const latestCommit = project.repositories[0]?.latestCommit;
    if (!latestCommit) {
      this.logger.error(
        `No latest commit found for repository ${project.repositories[0]?.name} in project ${project.slug} for organization ${organizationId}`,
      );
      throw new BadRequestException(
        `No latest commit found for repository ${project.repositories[0]?.name} in project ${project.slug} for organization ${organizationId}`,
      );
    }

    this.logger.log(`Setting commit id for issue ${key} to ${latestCommit.id}`);

    // Extract filePath from BFR for bug finding rule resolution
    const filePath = this.extractFilePathFromBfr(createIssueDto.bfr);

    if (createIssueDto.source === 'bug_finder') {
      // validate we have BFR and score
      if (!createIssueDto.bfr || !createIssueDto.score) {
        this.logger.error('BFR and score are required for bug finding rule issues. Skipping issue creation.');
        return null;
      }

      // validate BFR has valid filePath
      if (!filePath) {
        this.logger.error('BFR filePath is required for bug finding rule issues. Skipping issue creation.');
        return null;
      }
    }

    let bugFindingRule: BugFindingRule | undefined;
    if (filePath) {
      // Resolve bug finding rule
      bugFindingRule = await this.resolveBugFindingRule(projectId, filePath);

      if (!bugFindingRule) {
        this.logger.error(`No bug finding rule found for filePath: ${filePath} in project: ${projectId}. Skipping issue creation.`);
        return null;
      }
    }

    const bugFindingRuleId: string | undefined = bugFindingRule?.id ?? undefined;
    const metadata: any = createIssueDto.metadata ?? {};
    if (bugFindingRule) {
      metadata.bfr = bugFindingRule;
    }

    // Prepare the data object, ensuring we only include valid fields
    const issueData = {
      id: createIssueDto.id ?? undefined,
      title: createIssueDto.title,
      text: createIssueDto.text,
      shortText: createIssueDto.shortText ?? undefined,
      html: createIssueDto.html,
      issueUrl: createIssueDto.issueUrl,
      projectId,
      organizationId,
      createdById: user?.id ?? null,
      key,
      bugFindingRuleId,
      score: createIssueDto.score,
      commitId: latestCommit?.id,
      source: createIssueDto.source,
      rawData: createIssueDto.rawData,
      agentResultStatus: createIssueDto.agentResultStatus ?? AgentResultStatus.no_fix_available,
      agentProcessingStatus: createIssueDto.agentProcessingStatus ?? AgentProcessingStatus.not_started,
      metadata: metadata,
    };

    const issue = await this.prisma.issue.create({
      data: issueData,
    });

    this.logger.log(`Creating empty issue details for issue with key ${key}`);
    await this.prisma.issueDetails.create({
      data: {
        issueId: issue.id,
      },
    });

    this.logger.log(`Issue created with id: ${issue.id}`);

    await this.syncIssueComments(issue, createIssueDto.comments || []);

    if (submitToStorage) {
      await this.createIssueInCloudStorage(project, issue, latestCommit.id);
    } else {
      this.logger.log(`Skipping cloud storage upload for issue with id: ${issue.id}`);
    }

    const __meta = this.requestContextService.generateSSEMeta();

    await this.sseService.sendIssueEvent({
      event: 'issue_created',
      data: issue,
      __meta,
    });

    // Track bug_created analytics event
    await this.trackBugCreatedEvent(organizationId, projectId, issue.id);

    // Emit event to trigger aggregated status recalculation
    await this.eventEmitter.emitAsync(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, { issueId: issue.id });

    return issue;
  }

  async getIssues(
    projectId: string,
    organizationId: string,
    excludeArchived = false,
    source?: string,
    filters?: IssueFilters,
  ): Promise<IIssueListItem[]> {
    // Get the project ID
    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
        organizationId,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found in organization ${organizationId}`);
    }

    let whereClause: any = {
      projectId: project.id,
      organizationId,
      isDeleted: false,
    };

    // Add filter to exclude archived issues if requested
    if (excludeArchived) {
      whereClause.isArchived = false;
    }

    if (filters) {
      whereClause = {
        ...whereClause,
        ...filters,
      };
    }

    // Add source filtering if provided
    const sourceFilter = this.buildSourceFilter(source);
    if (sourceFilter) {
      whereClause.OR = sourceFilter;
    }

    const existingIssues = await this.prisma.issue.findMany({
      where: whereClause,
      omit: {
        text: true,
        shortText: true,
        rawData: true,
        html: true,
        cloudStorageInfo: true,
      },
      include: {
        pullRequests: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
        commit: true,
        details: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
          select: {
            id: true,
            updatedAt: true,
            slicerVersion: true,
          },
        },
        feedbacks: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        bugFindingRule: {
          select: {
            id: true,
            title: true,
            filePath: true,
            category: true,
            impact: true,
            metadata: true,
          },
        },
      },
      orderBy: [
        {
          agentResultStatus: 'asc',
        },
        {
          id: 'asc',
        },
      ],
    });

    const issueDetailsIds = existingIssues.map((issue) => issue.details?.[0]?.id).filter((id): id is string => Boolean(id));
    const issueDetailsTagRows = await this.prisma.issueDetailsTag.findMany({
      where: {
        issueDetailsId: {
          in: issueDetailsIds,
        },
      },
      include: {
        tag: true,
      },
    });

    const issues = existingIssues.map((issue) => {
      const issueDetails = issue.details?.[0];
      const { pullRequests, feedbacks, ...issueWithoutPullRequests } = issue;
      const pullRequest = pullRequests?.[0];
      const updatedAt = issueDetails?.updatedAt || issue.updatedAt;

      const tags = issueDetailsTagRows
        .filter((tag) => tag.issueDetailsId === issueDetails?.id)
        .map((tag) => {
          return {
            slug: tag.tag.slug,
            displayName: tag.tag.displayName,
            tooltip: tag.tag.tooltip,
          };
        });

      if (pullRequest) {
        const { issueId: _prIssueId, title: _title, ...pullRequestWithoutFields } = pullRequest;
        return {
          ...issueWithoutPullRequests,
          commit: toResponseCommit(issueWithoutPullRequests.commit as PrismaCommit),
          pullRequest: pullRequestWithoutFields,
          updatedAt,
          slicerVersion: issueDetails?.slicerVersion,
          feedbacks,
          bugFindingRule: issue.bugFindingRule,
          tags,
        };
      }

      return {
        ...issueWithoutPullRequests,
        commit: toResponseCommit(issueWithoutPullRequests.commit as PrismaCommit),
        pullRequest: null,
        updatedAt,
        slicerVersion: issueDetails?.slicerVersion,
        feedbacks,
        bugFindingRule: issue.bugFindingRule,
        tags,
      };
    });

    return issues as IIssueListItem[];
  }

  public async getIssue(projectId: string, issueId: string): Promise<IIssue> {
    const issue = await this.prisma.issue.findUnique({
      where: {
        id: issueId,
        projectId,
      },
      include: {
        feedbacks: {
          orderBy: {
            createdAt: 'desc',
          },
        },
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId}`);
    }

    return toIIssue(issue);
  }

  public async getIssueById(issueId: string): Promise<Issue> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found`);
    }

    return issue;
  }

  public async updateIssueProcessingStatus(existingIssue: Issue, taskStatus: TaskStatus, originalTask?: Task): Promise<Issue> {
    const newAgentProcessingStatus = getAgentProcessingStatus(taskStatus);

    this.logger.log(`New agent processing status: ${newAgentProcessingStatus}`);

    if (existingIssue.agentProcessingStatus === newAgentProcessingStatus) {
      this.logger.log(
        `Skipping issue processing status update for issue ${existingIssue.key} (${existingIssue.id}) - status already ${newAgentProcessingStatus}`,
      );
      return existingIssue;
    }

    const data: Prisma.IssueUpdateInput = {
      agentProcessingStatus: newAgentProcessingStatus,
    };

    if (taskStatus === TaskStatus.failed) {
      data.agentResultStatus = AgentResultStatus.error;
    }

    this.logger.log(`Updating issue processing status for issue ${existingIssue.key} (${existingIssue.id}) to ${newAgentProcessingStatus}`);
    const result = await this.prisma.issue.update({
      where: { id: existingIssue.id },
      data: data,
    });

    const __meta = this.requestContextService.generateSSEMeta();

    await this.sseService.sendIssueEvent({
      event: 'issue_updated',
      data: result,
      __meta,
    });

    // Emit event to trigger aggregated status recalculation
    await this.eventEmitter.emitAsync(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, { issueId: existingIssue.id, originalTask });

    return result;
  }

  public async updateIssue(
    existingIssue: Issue,
    issueDetailsDetailed: IssueStatusDetailed,
    taskStatus: TaskStatus,
    originalTask?: Task,
  ): Promise<Issue> {
    const newAgentResultStatus = getAgentResultStatus(issueDetailsDetailed);
    const newAgentProcessingStatus = getAgentProcessingStatus(taskStatus);

    this.logger.log(`New agent result status: ${newAgentResultStatus}`);
    this.logger.log(`New agent processing status: ${newAgentProcessingStatus}`);

    const isStatusChanged =
      existingIssue.agentProcessingStatus !== newAgentProcessingStatus || existingIssue.agentResultStatus !== newAgentResultStatus;

    if (!isStatusChanged) {
      this.logger.log(`Skipping issue update for issue ${existingIssue.key} (${existingIssue.id}) - no status changes detected`);
      return existingIssue;
    }

    const data: Prisma.IssueUpdateInput = {
      agentResultStatus: newAgentResultStatus,
      agentProcessingStatus: newAgentProcessingStatus,
    };

    this.logger.log(
      `Updating issue ${existingIssue.key} (${existingIssue.id}) with agentResultStatus=${newAgentResultStatus} and agentProcessingStatus=${newAgentProcessingStatus}`,
    );
    const result = await this.prisma.issue.update({
      where: { id: existingIssue.id },
      data: data,
    });

    const __meta = this.requestContextService.generateSSEMeta();

    // TODO: check if there are some side-effects that need to be handled here.
    await this.sseService.sendIssueEvent({
      event: 'issue_updated',
      data: result,
      __meta,
    });

    // Emit stats event when a fix is validated (status changes to validated_fix)
    if (newAgentResultStatus === AgentResultStatus.validated_fix && existingIssue.agentResultStatus !== AgentResultStatus.validated_fix) {
      this.eventEmitter.emit(STATS_EVENTS.FIX_APPLIED, {
        organizationId: existingIssue.organizationId,
      });
    }

    // Emit event to trigger aggregated status recalculation
    await this.eventEmitter.emitAsync(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, { issueId: existingIssue.id, originalTask });

    return result;
  }

  private async deleteSingleIssueDetails(projectId: string, issue: Issue, issueDetails: PrismaIssueDetails): Promise<void> {
    const storageDirectories = issueDetails ? extractStorageDirectories(issueDetails as PrismaIssueDetails) : new Set<string>();

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if (!project.organization) {
      throw new NotFoundException(`Organization not found for project ${projectId}`);
    }

    if (issueDetails) {
      this.logger.log(`Deleting issue details ${issueDetails.id} for issue ${issue.id}`);
      await this.prisma.issueDetails.delete({
        where: {
          id: issueDetails.id,
        },
      });
    }

    // Only create cleanup task if there are directories to clean up
    if (storageDirectories.size > 0) {
      const directoriesPayload = Array.from(storageDirectories);

      this.logger.log(`Creating cleanup task for ${directoriesPayload.length} directories: ${directoriesPayload.join(', ')}`);
      const issueFileName = this.cloudStorageService.getFileNameOnly(issue.id);
      const payload: StorageCleanupPayload = {
        version: 1,
        directories: directoriesPayload,
        taskFileNames: [issueFileName],
      };
      const task = await this.taskService.createTask({
        type: TaskTypes.STORAGE_CLEANUP,
        payload,
        projectSlug: project.slug,
        orgSlug: project.organization.slug,
        projectId,
        organizationId: issue.organizationId,
      });

      // Upload the cleanup task to cloud storage
      const cloudStorageTask = await this.logicTasksCommunicationService.uploadTaskFile(project, project.organization, task);
      this.logger.log(`Storage cleanup task uploaded to cloud storage: ${cloudStorageTask.fullPath}`);
    } else {
      this.logger.log(`No directories to clean up for issue ${issue.id}`);
    }
  }

  async delete(projectId: string, issueId: string): Promise<void> {
    // validate this issue is part of the project
    const issue = await this.prisma.issue.findUnique({
      where: {
        id: issueId,
        projectId,
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId}`);
    }

    const issueDetailsArray = await this.prisma.issueDetails.findMany({
      where: {
        issueId,
      },
    });
    for (const issueDetails of issueDetailsArray) {
      await this.deleteSingleIssueDetails(projectId, issue, issueDetails);
    }

    // delete pull requests first to avoid FK constraint issues
    this.logger.log(`Deleting pull requests for issue ${issueId}`);
    await this.prisma.pullRequest.deleteMany({
      where: {
        issueId,
      },
    });

    // delete issue comments
    this.logger.log(`Deleting issue comments for issue ${issueId}`);
    await this.prisma.issueComment.deleteMany({
      where: {
        issueId,
      },
    });

    this.logger.log(`Deleting issue ${issueId}`);
    await this.prisma.issue.delete({
      where: {
        id: issueId,
      },
    });

    this.logger.log(`Issue ${issueId} deleted from project ${projectId}`);
  }

  async deleteForProject(projectId: string, organizationId: string): Promise<void> {
    // Check if project exists
    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
        organizationId,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found in organization ${organizationId}`);
    }

    // Use a transaction to ensure atomicity of delete operations
    await this.prisma.$transaction(async (tx) => {
      const issueIdsForDelete = (
        await this.prisma.issue.findMany({
          where: {
            projectId,
            organizationId,
          },
          select: {
            id: true,
          },
        })
      ).map((issue) => issue.id);

      this.logger.log(`Deleting issue details for ${issueIdsForDelete.length} issues`);
      // Delete all issue details for the project
      await tx.issueDetails.deleteMany({
        where: {
          issueId: {
            in: issueIdsForDelete,
          },
        },
      });

      this.logger.log(`Deleting issue comments for ${issueIdsForDelete.length} issues`);
      // Delete all issue comments for the project
      await tx.issueComment.deleteMany({
        where: {
          issueId: {
            in: issueIdsForDelete,
          },
        },
      });

      this.logger.log(`Deleting issues for ${issueIdsForDelete.length} issues`);
      // Delete all issues for the project
      await tx.issue.deleteMany({
        where: {
          id: {
            in: issueIdsForDelete,
          },
        },
      });
    });
  }

  async getIssueByKeyAndProjectSlug(issueKey: string, projectSlug: string): Promise<Issue | null> {
    const result = await this.prisma.issue.findFirst({
      where: {
        key: issueKey,
        project: { slug: projectSlug },
      },
    });

    if (!result) {
      return null;
    }

    return result;
  }

  private async ensureTags(tags?: Tag[]): Promise<string[] | []> {
    const result: ITag[] = [];

    if (!tags) {
      return [];
    }

    for (const tag of tags) {
      const existingTag = await this.prisma.tag.findUnique({
        where: {
          slug: tag.tag_slug,
        },
      });

      if (existingTag) {
        if (existingTag.displayName !== tag.display_name || existingTag.tooltip !== tag.tool_tip) {
          const updatedTag = await this.prisma.tag.update({
            where: { id: existingTag.id },
            data: { displayName: tag.display_name, tooltip: tag.tool_tip },
          });
          result.push(updatedTag);
        } else {
          result.push(existingTag);
        }
      } else {
        const newTag = await this.prisma.tag.create({
          data: {
            slug: tag.tag_slug,
            displayName: tag.display_name,
            tooltip: tag.tool_tip,
          },
        });
        result.push(newTag);
      }
    }

    const tagIds = result.map((tag) => tag.id);
    return tagIds;
  }

  public async createIssueDetails(issueId: string, issueDetails: IssueDetails): Promise<PrismaIssueDetails> {
    this.logger.log(`Creating new issue details for issue ${issueId}`);
    const result = await this.prisma.issueDetails.create({
      data: {
        issueId,
        fix: (issueDetails.fix || []) as any,
        reproductionScript: (issueDetails.reproduction_script || []) as any,
        investigationReport: (issueDetails.investigation_report || {}) as any,
        modifiedUnitTests: (issueDetails.modified_unit_tests || []) as any,
        existingUnitTests: (issueDetails.existing_unit_tests || []) as any,
        newUnitTests: (issueDetails.new_unit_tests || []) as any,
        regressionTests: (issueDetails.regression_tests || []) as any,
        acceptanceTests: (issueDetails.acceptance_tests || []) as any,
        fixTitle: issueDetails.fix_title,
        fixRootCause: issueDetails.fix_root_cause,
        fixOverview: issueDetails.fix_overview,
        slicerVersion: issueDetails.slicer_version,
        reproductionConfidence: issueDetails.reproduction_confidence,
        fixPrDescription: issueDetails.fix_pr_description,
        fixCommitMessage: issueDetails.fix_commit_message,
        fixSummary: (issueDetails.fix_summary || undefined) as any,
        reviewResponse: issueDetails.review_response,
        solvedTaskStoragePath: issueDetails.solved_task_storage_path,
        abstentionReason: issueDetails.abstention_reason,
      },
    });

    const tagIds = await this.ensureTags(issueDetails.tags);
    if (tagIds.length > 0) {
      await this.prisma.issueDetailsTag.createMany({
        data: tagIds.map((tagId) => ({
          issueDetailsId: result.id,
          tagId,
        })),
        skipDuplicates: true,
      });
    }

    const isIssueFixed = isValidatedFix(issueDetails.status_result?.issue_status);
    if (isIssueFixed) {
      this.logger.log(`Issue ${issueId} is now fixed, emitting issue fixed event`);
      const existingIssue = await this.prisma.issue.findUnique({
        where: { id: issueId },
      });

      await this.eventEmitter.emit(ISSUE_EVENTS.ISSUE_FIXED, {
        issue: existingIssue,
      });
    }

    // Recalculate aggregated status after creating issue details
    await this.eventEmitter.emitAsync(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, { issueId });

    return result;
  }

  async updateIssueDetailsWithValidation(
    issueId: string,
    issueDetailsId: string,
    updateIssueDetailsDto: UpdateIssueDetailsDto,
  ): Promise<IIssueDetails> {
    // Verify the issue exists and belongs to the project
    const issueDetails = await this.prisma.issueDetails.findUnique({
      where: {
        id: issueDetailsId,
        issueId,
      },
    });

    if (!issueDetails) {
      throw new NotFoundException(`Issue details ${issueDetailsId} not found for issue ${issueId}`);
    }

    // Update the issue details
    const updatedIssueDetails = await this.prisma.issueDetails.update({
      where: { id: issueDetailsId },
      data: {
        fix: (updateIssueDetailsDto.fix || []) as any,
        reproductionScript: (updateIssueDetailsDto.reproduction_script || []) as any,
        investigationReport: (updateIssueDetailsDto.investigation_report || {}) as any,
        modifiedUnitTests: (updateIssueDetailsDto.modified_unit_tests || []) as any,
        existingUnitTests: (updateIssueDetailsDto.existing_unit_tests || []) as any,
        newUnitTests: (updateIssueDetailsDto.new_unit_tests || []) as any,
        regressionTests: (updateIssueDetailsDto.regression_tests || []) as any,
        acceptanceTests: (updateIssueDetailsDto.acceptance_tests || []) as any,
        fixTitle: updateIssueDetailsDto.fix_title,
        fixRootCause: updateIssueDetailsDto.fix_root_cause,
        fixOverview: updateIssueDetailsDto.fix_overview,
        slicerVersion: updateIssueDetailsDto.slicer_version,
        reproductionConfidence: updateIssueDetailsDto.reproduction_confidence,
        fixPrDescription: updateIssueDetailsDto.fix_pr_description,
        fixCommitMessage: updateIssueDetailsDto.fix_commit_message,
        fixSummary: (updateIssueDetailsDto.fix_summary || undefined) as any,
        reviewResponse: updateIssueDetailsDto.review_response,
        solvedTaskStoragePath: updateIssueDetailsDto.solved_task_storage_path,
        abstentionReason: updateIssueDetailsDto.abstention_reason,
      },
      include: {
        issue: true,
      },
    });

    return {
      issue: toIIssue(updatedIssueDetails.issue),
      stats: getIssueDetailsStats(updatedIssueDetails),
      issueDetailsId: updatedIssueDetails.id,
      createdAt: updatedIssueDetails.createdAt,
      updatedAt: updatedIssueDetails.updatedAt,
    };
  }

  async getIssueDetailsList(projectId: string, issueId: string): Promise<IIssueDetailsListItem[]> {
    const issueDetailsList = await this.prisma.issueDetails.findMany({
      where: {
        issueId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    const result: IIssueDetailsListItem[] = [];
    for (let i = 0; i < issueDetailsList.length; i++) {
      const issueDetails = issueDetailsList[i];
      const enrichedIssueDetails: IIssueDetails = await this.getIssueDetails(projectId, issueId, issueDetails.id);
      result.push({
        ...enrichedIssueDetails,
        iteration: i + 1,
      });
    }

    return result;
  }

  /**
   * Gets all revisions for an issue with comment counts and commenters.
   *
   * Note: Global comments (threads without a file/line association) are limited to
   * only the first one per revision. This is intentional - there should only be one
   * global/phase-level comment per revision.
   *
   * @pivanov: Historical context: A frontend bug previously caused duplicate global comments
   * to be created during phase creation. This has been fixed, but existing data may
   * still contain duplicates. We only count the first global comment to ensure
   * consistent counts between API and frontend.
   */
  async getIssueRevisions(issueId: string): Promise<IIssueRevision[]> {
    const issueDetailsList = await this.prisma.issueDetails.findMany({
      where: {
        issueId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      include: {
        reviewSessions: {
          include: {
            sessionThreads: {
              include: {
                reviewThread: {
                  include: {
                    comments: {
                      include: {
                        author: {
                          select: {
                            id: true,
                            username: true,
                            email: true,
                          },
                        },
                      },
                      orderBy: {
                        createdAt: 'asc',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const result: IIssueRevision[] = [];

    for (let i = 0; i < issueDetailsList.length; i++) {
      const issueDetails = issueDetailsList[i];

      let totalComments = 0;
      let hasCountedGlobalComment = false;
      const uniqueCommentersMap = new Map<string, Pick<IUserInfo, 'id' | 'username' | 'email'>>();
      const threads: IReviewThread[] = [];

      for (const session of issueDetails.reviewSessions) {
        for (const sessionThread of session.sessionThreads) {
          const thread = sessionThread.reviewThread;
          if (!thread?.comments || thread.comments.length === 0) {
            continue;
          }

          const isGlobalComment = !thread.file && thread.startLine == null && thread.endLine == null;

          if (isGlobalComment) {
            if (hasCountedGlobalComment) {
              continue;
            }
            hasCountedGlobalComment = true;
            threads.push(thread as IReviewThread);
            totalComments += 1;

            const firstComment = thread.comments[0];
            if (firstComment?.author?.id && !uniqueCommentersMap.has(firstComment.author.id)) {
              uniqueCommentersMap.set(firstComment.author.id, {
                id: firstComment.author.id,
                username: firstComment.author.username || firstComment.author.email.split('@')[0],
                email: firstComment.author.email,
              });
            }
          } else {
            threads.push(thread as IReviewThread);
            totalComments += thread.comments.length;

            for (const comment of thread.comments) {
              if (comment.author?.id && !uniqueCommentersMap.has(comment.author.id)) {
                uniqueCommentersMap.set(comment.author.id, {
                  id: comment.author.id,
                  username: comment.author.username || comment.author.email.split('@')[0],
                  email: comment.author.email,
                });
              }
            }
          }
        }
      }

      const latestReviewSession = issueDetails.reviewSessions[issueDetails.reviewSessions.length - 1];

      result.push({
        issueDetailsId: issueDetails.id,
        iteration: i + 1,
        createdAt: issueDetails.createdAt,
        totalComments,
        commenters: Array.from(uniqueCommentersMap.values()),
        state: latestReviewSession?.state as ReviewSessionState,
        reviewResponse: issueDetails.reviewResponse,
        threads,
      });
    }

    return result;
  }

  /**
   * Gets an enriched issue details object with pull requests, feedbacks, and commit. Can return latest or specific issue details by id.
   * @param projectId The project id to get the details for
   * @param issueId The issue id to get the details for
   * @param issueDetailsId Pass in the issue details id to get a specific issue details, if not passed in, will get the latest issue details
   * @returns
   */
  async getIssueDetails(projectId: string, issueId: string, issueDetailsId?: string): Promise<IIssueDetails> {
    const project = await this.prisma.project.findUnique({
      where: {
        id: projectId,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get the issue with pull requests and bug
    const issueWithPullRequests = await this.prisma.issue.findFirst({
      where: {
        projectId,
        id: issueId,
      },
      include: {
        commit: true,
        pullRequests: {
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
        feedbacks: {
          orderBy: {
            createdAt: 'desc',
          },
        },
        bug: {
          select: {
            id: true,
          },
        },
      },
      omit: {
        cloudStorageInfo: true,
      },
    });

    if (!issueWithPullRequests) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId}`);
    }

    // We can either get the latest issue details or a specific issue details by id
    const where: Prisma.IssueDetailsWhereInput = {
      issueId: issueWithPullRequests.id,
    };
    if (issueDetailsId) {
      where.id = issueDetailsId;
    }

    // Get the latest issue details from the database
    const details = await this.prisma.issueDetails.findFirst({
      where,
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        issue: true,
      },
    });

    if (!details) {
      throw new NotFoundException(`Issue details not found for issue ${issueId}`);
    }

    const issueDetailsTags = await this.prisma.issueDetailsTag.findMany({
      where: {
        issueDetailsId: details.id,
      },
      include: {
        tag: true,
      },
    });

    // Get the review sessions for this issue detail
    const reviewSessions = await this.reviewSessionsService.getReviewSessionsByIssueDetail(details.id);

    const stats = getIssueDetailsStats(details);

    // Return the data in V2FixDetails format
    return {
      issueDetailsId: details.id,
      createdAt: details.createdAt,
      updatedAt: details.updatedAt,
      issue: toIIssue(issueWithPullRequests as PrismaIssueWithRelations),
      fix: details.fix as any,
      reproduction_script: details.reproductionScript as any,
      investigation_report: details.investigationReport as any,
      modified_unit_tests: details.modifiedUnitTests as any,
      existing_unit_tests: details.existingUnitTests as any,
      new_unit_tests: details.newUnitTests as any,
      regression_tests: details.regressionTests as any,
      acceptance_tests: details.acceptanceTests as any,
      fix_title: details.fixTitle,
      fix_root_cause: details.fixRootCause,
      fix_overview: details.fixOverview,
      fix_summary: details.fixSummary as any,
      slicerVersion: details.slicerVersion,
      reproduction_confidence: details.reproductionConfidence,
      fix_pr_description: details.fixPrDescription,
      fix_commit_message: details.fixCommitMessage,
      review_response: details.reviewResponse,
      solved_task_storage_path: details.solvedTaskStoragePath,
      abstention_reason: details.abstentionReason,
      tags: issueDetailsTags.map(({ tag }) => ({
        tag_slug: tag.slug,
        display_name: tag.displayName,
        tool_tip: tag.tooltip,
      })),
      stats,
      reviewSessions: reviewSessions.length ? reviewSessions : undefined,
    };
  }

  private checkIsForDeletion(issue: AsanaTask): boolean {
    // GEM: If it contains Escalated as part of the membership.section.name it's for deletion
    const containsEscalated = issue.memberships.some((membership) => membership.section.name.includes('Escalated'));
    if (containsEscalated) {
      this.logger.log(`Issue ${issue.gid} - ${issue.name} - contains Escalated in the membership.section.name, marking as for deletion`);
    }
    return containsEscalated;
  }

  async fetchRecentIssues(
    integration: Integration,
    integrationMapping: ProjectIntegrationMapping,
    includeComments: boolean = true,
    limit?: number,
    /**
     * Optional overrides for isCompleted logic.
     * When ignoreMappings is used, the mapping passed to this method has its mapping stripped so that providers don't filter issues.
     * In that case, mappingForCompletion carries the original DB mapping
     * so that isCompleted can still be calculated from its statusMapping.closed while fetch uses the stripped mapping.
     */
    options?: { mappingForCompletion?: ProjectIntegrationMapping },
  ): Promise<IssueSyncResponseDto[]> {
    let issues: IssueSyncResponseDto[] = [];
    const integrationType = integrationMapping.integrationType || integration.type;
    const completionMapping = options?.mappingForCompletion ?? integrationMapping;
    if (integration.provider === IntegrationProvider.asana) {
      const asanaIssues = await this.asanaService.getTasks(integration, integrationMapping);

      issues = asanaIssues.map((issue) => ({
        title: issue.name,
        text: issue.notes,
        key: issue.gid,
        projectId: integrationMapping.projectId,
        organizationId: integration.organizationId,
        html: issue.html_notes,
        isCompleted: issue.completed,
        isForDeletion: this.checkIsForDeletion(issue),
        source: 'asana',
        issueUrl: `https://app.asana.com/1/${issue.workspace.gid}/task/${issue.gid}`,
        rawData: issue,
        comments: issue.comments?.map((comment) => ({
          externalId: comment.gid,
          text: comment.text,
          createdAt: new Date(comment.created_at),
          author: {
            name: comment.created_by?.name,
          },
        })),
      }));
    } else if (integration.provider === IntegrationProvider.atlassian) {
      const mapping = completionMapping as ProjectManagementIntegrationsMapping;
      const baseUrl = await this.atlassianService.ensureBaseUrl(integration, integrationMapping);
      const jiraIssues: JiraIssue[] = await this.atlassianService.getIssues(integration, integrationMapping, limit, includeComments);

      for (const issue of jiraIssues) {
        const issueUrl = baseUrl ? `${baseUrl}/browse/${issue.key}` : '';
        const closedStatuses = mapping.metadata?.statusMapping?.closed || [];
        const isCompleted = closedStatuses.includes(issue.status);

        issues.push({
          title: issue.summary,
          text: issue.description,
          key: issue.key,
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: '', // not supported yet. We can convert MD to HTML later.
          isCompleted,
          isForDeletion: false,
          source: 'jira',
          issueUrl,
          rawData: issue,
          assignee: issue.assignee
            ? {
                id: issue.assignee.id,
                name: issue.assignee.displayName,
                email: issue.assignee.emailAddress,
              }
            : undefined,
          createdDate: issue.created ? new Date(issue.created) : undefined,
          updatedDate: new Date(issue.updated),
          comments: issue.comments.map((comment) => ({
            externalId: comment.id,
            text: comment.body,
            createdAt: new Date(comment.created),
            author: {
              name: comment?.author?.name,
            },
          })),
        });
      }
    } else if (integration.provider === IntegrationProvider.trello) {
      const trelloIssues: TrelloIssue[] = await this.trelloService.getIssues(integration, integrationMapping);

      for (const issue of trelloIssues) {
        issues.push({
          title: issue.name,
          text: issue.desc,
          key: issue.id,
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: '',
          isCompleted: issue.closed,
          isForDeletion: false,
          source: 'trello',
          issueUrl: issue.url,
          rawData: issue,
          comments: issue.comments.map((comment: TrelloComment) => ({
            externalId: comment.id,
            text: comment.data.text,
            createdAt: new Date(comment.date),
            author: {
              name: comment.memberCreator?.fullName || '',
            },
          })),
        });
      }
    } else if (integration.provider === IntegrationProvider.github) {
      if (integrationType !== IntegrationType.project_management) {
        throw new BadRequestException(`Integration type ${integrationType} is not supported for GitHub issues`);
      }

      const githubIssues: GitHubIssue[] = await this.githubIssuesService.getIssues(integration, integrationMapping, limit);

      for (const issue of githubIssues) {
        const mapping = completionMapping as ProjectManagementIntegrationsMapping;
        const closedStatuses = mapping.metadata?.statusMapping?.closed || [];
        const isCompleted = closedStatuses.includes(issue.state);

        issues.push({
          title: issue.title,
          text: issue.body,
          key: issue.number.toString(),
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: issue.body_html || '',
          isCompleted,
          isForDeletion: false,
          source: 'github',
          issueUrl: issue.html_url,
          rawData: issue,
          assignee: issue.assignee
            ? {
                id: issue.assignee.id.toString(),
                name: issue.assignee.login,
                email: undefined, // GitHub API doesn't provide email in issue responses
              }
            : undefined,
          createdDate: new Date(issue.created_at),
          updatedDate: new Date(issue.updated_at),
          comments:
            issue.comments_data?.map((comment) => ({
              externalId: comment.id.toString(),
              text: comment.body,
              createdAt: new Date(comment.created_at),
              author: {
                name: comment.user?.login || '',
              },
            })) || [],
        });
      }
    } else if (integration.provider === IntegrationProvider.gitlab) {
      if (integrationType !== IntegrationType.project_management) {
        throw new BadRequestException(`Integration type ${integrationType} is not supported for GitLab issues`);
      }

      const gitlabIssues: GitLabIssue[] = await this.gitlabIssuesService.getIssues(integration, integrationMapping);

      for (const issue of gitlabIssues) {
        const mapping = completionMapping as ProjectManagementIntegrationsMapping;
        const closedStatuses = mapping?.metadata?.statusMapping?.closed || [];
        const isCompleted = closedStatuses.includes(issue.state);

        issues.push({
          title: issue.title,
          text: issue.description,
          key: issue.iid.toString(),
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: '', // GitLab doesn't provide HTML version in the API
          isCompleted,
          isForDeletion: false,
          source: 'gitlab',
          issueUrl: issue.web_url,
          rawData: issue,
          comments:
            issue.comments_data?.map((comment) => ({
              externalId: comment.id.toString(),
              text: comment.body,
              createdAt: new Date(comment.created_at),
              author: {
                name: comment?.author?.name,
              },
            })) || [],
        });
      }
    } else if (integration.provider === IntegrationProvider.linear) {
      const linearIssues: ILinearIssue[] = await this.linearIssuesService.getIssues(integration, integrationMapping);

      for (const issue of linearIssues) {
        const mapping = completionMapping as ProjectManagementIntegrationsMapping;
        const closedStatuses = mapping?.metadata?.statusMapping?.closed || [];
        const isCompleted = closedStatuses.includes(issue.status);

        issues.push({
          title: issue.title,
          text: issue.description || '',
          key: issue.identifier,
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: '',
          isCompleted,
          isForDeletion: false,
          source: 'linear',
          issueUrl: issue.url || '',
          rawData: issue,
          assignee: issue.assignee,
          createdDate: issue.createdAt ? new Date(issue.createdAt) : undefined,
          updatedDate: new Date(issue.updatedAt),
          comments: issue.comments.map((comment) => ({
            externalId: comment.id,
            text: comment.body,
            createdAt: new Date(comment.createdAt),
            author: {
              name: comment.author.name,
            },
          })),
        });
      }
    } else if (integration.provider === IntegrationProvider.notion) {
      const mapping = completionMapping as ProjectManagementIntegrationsMapping;
      const notionIssues: NotionIssue[] = await this.notionService.getIssues(integration, integrationMapping, limit);

      for (const issue of notionIssues) {
        // Determine if issue is completed based on status mapping
        const closedStatuses = mapping.metadata?.statusMapping?.closed || [];
        const isCompleted = issue.status ? closedStatuses.includes(issue.status) : false;

        issues.push({
          title: issue.title,
          text: issue.text,
          key: issue.key,
          projectId: integrationMapping.projectId,
          organizationId: integration.organizationId,
          html: '',
          isCompleted,
          isForDeletion: false,
          source: 'notion',
          issueUrl: issue.issueUrl,
          rawData: issue,
          assignee: issue.createdBy
            ? {
                id: issue.createdBy.id,
                name: issue.createdBy.name || '',
                email: issue.createdBy.email,
              }
            : undefined,
          createdDate: new Date(issue.createdAt),
          updatedDate: new Date(issue.updated),
          comments: [], // Notion doesn't support comments in v1
        });
      }
    } else {
      throw new BadRequestException(`Unsupported integration provider: ${integration.provider}`);
    }

    return issues;
  }

  private async syncIssueComments(issue: Issue, comments: IssueCommentSyncDto[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // just delete all comments for the issue
      // so that we can handle the case where the comments are not present in the sync data anymore
      await tx.issueComment.deleteMany({
        where: {
          issueId: issue.id,
        },
      });

      // create new comments
      await tx.issueComment.createMany({
        data: comments.map((comment) => ({
          issueId: issue.id,
          externalId: comment.externalId,
          text: comment.text,
          createdAt: comment.createdAt,
          author: {
            name: comment.author?.name,
          },
        })),
      });
    });

    this.logger.log(`Synced ${comments.length} comments for issue key ${issue.key} and id ${issue.id}`);
  }

  async syncIssueCreated(organizationId: string, projectId: string, issue: IssueSyncResponseDto): Promise<void> {
    if (issue.isForDeletion) {
      this.logger.log(`Newly found issue ${issue.key} is marked for deletion, skipping creation`);
      return;
    }

    if (issue.isCompleted) {
      this.logger.log(`Newly found issue ${issue.key} is completed, skipping creation`);
      return;
    }

    this.logger.log(`Issue ${issue.key} does not exist in database, creating it`);
    // TODO: Add the HTML for the issue here, too.
    const newIssue = await this.createIssue(
      projectId,
      organizationId,
      {
        key: issue.key,
        title: issue.title,
        text: issue.text || '',
        html: issue.html || '',
        issueUrl: issue.issueUrl,
        source: issue.source,
        rawData: JSON.stringify(issue),
        comments:
          issue.comments?.map((comment) => ({
            externalId: comment.externalId,
            text: comment.text,
            createdAt: comment.createdAt,
          })) || [],
      },
      true,
    );

    if (newIssue) {
      this.logger.log(`Issue ${issue.key} created with id: ${newIssue.id}`);
    }
  }

  async syncIssueUpdated(existingIssue: Issue, issue: IssueSyncResponseDto, shouldSyncComments = true): Promise<void> {
    this.logger.log(`Issue ${issue.key} already exists in database`);

    if (issue.isForDeletion) {
      this.logger.log(`Newly found issue ${issue.key} is marked for deletion, skip update. Mark as deleted.`);
      await this.prisma.issue.update({
        where: { id: existingIssue.id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      });
      return;
    }

    if (issue.isCompleted) {
      if (existingIssue.isArchived) {
        this.logger.log(`Issue ${issue.key} (${existingIssue.id}) is already completed and archived. No update needed.`);
        return;
      }

      // archive the issue
      this.logger.log(`Issue ${issue.key} (${existingIssue.id}) is completed - archiving it.`);
      await this.archiveIssue(existingIssue.projectId, existingIssue.id, existingIssue.organizationId);
      return;
    } else if (!issue.isCompleted) {
      if (existingIssue.isArchived) {
        // unarchive the issue
        this.logger.log(`Issue ${issue.key} (${existingIssue.id}) is not completed and is archived. Unarchiving it.`);
        await this.unarchiveIssue(existingIssue.projectId, existingIssue.id, existingIssue.organizationId);
      }
    }

    await this.prisma.issue.update({
      where: { id: existingIssue.id },
      data: {
        text: issue.text || '',
        title: issue.title,
        html: issue.html,
        issueUrl: issue.issueUrl,
        source: issue.source,
        rawData: JSON.stringify(issue),
      },
    });

    if (shouldSyncComments) {
      await this.syncIssueComments(existingIssue, issue.comments || []);
    }
  }

  async hasSyncIssues(projectId: string): Promise<boolean> {
    const count = await this.prisma.projectIntegrationMapping.count({
      where: {
        OR: [
          {
            integration: {
              type: IntegrationType.project_management,
            },
          },
          {
            integrationType: IntegrationType.project_management,
          },
        ],
        projectId,
      },
    });

    this.logger.log(`Found ${count} project management integrations for project ${projectId}`);

    const result = count > 0;
    return result;
  }

  async syncIssues(organizationId: string, projectId: string): Promise<ISyncIssuesResponse> {
    const lastSyncedAt = new Date(new Date().toISOString());

    // We continue syncing other mappings to maximize progress, but we must not advance
    // lastSyncedAt for a mapping when any part of that mapping run fails.
    const failedMappingIds: string[] = [];

    const integrationMappings = await this.prisma.projectIntegrationMapping.findMany({
      where: {
        OR: [
          {
            integration: {
              type: IntegrationType.project_management,
            },
          },
          {
            integrationType: IntegrationType.project_management,
          },
        ],
        projectId,
      },
      include: {
        integration: true,
      },
    });

    if (integrationMappings.length === 0) {
      this.logger.error(`Project Management integration mapping not found for project ${projectId} and organization ${organizationId}`);
      throw new BadRequestException('Project Management integration mapping not found');
    }

    this.logger.log(`Syncing ${integrationMappings.length} project management mapping(s) for project ${projectId}`);

    let updatedIssuesCount = 0;
    let createdIssuesCount = 0;

    for (const integrationMapping of integrationMappings) {
      let mappingHadFailure = false;

      try {
        this.logger.log(`Syncing integration mapping ${integrationMapping.id}`);
        const integration = integrationMapping.integration;
        let issues: IssueSyncResponseDto[] = [];

        try {
          issues = await this.fetchRecentIssues(integration, integrationMapping);
        } catch (error) {
          mappingHadFailure = true;
          this.logger.error(`Error fetching issues for mapping ${integrationMapping.id}: ${error}`);
        }

        for (const issue of issues) {
          try {
            const existingIssue = await this.prisma.issue.findFirst({
              where: {
                key: issue.key,
                projectId,
                organizationId,
              },
            });

            if (existingIssue) {
              await this.syncIssueUpdated(existingIssue, issue);
              updatedIssuesCount++;
            } else {
              await this.syncIssueCreated(organizationId, projectId, issue);
              createdIssuesCount++;
            }
          } catch (error) {
            mappingHadFailure = true;
            this.logger.error(`Error syncing issue ${issue.key}: ${error}`);
          }
        }

        if (mappingHadFailure) {
          failedMappingIds.push(integrationMapping.id);
          this.logger.warn(
            `One or more errors occurred while syncing mapping ${integrationMapping.id}; skipping lastSyncedAt update so the next run can retry incrementally.`,
          );
          continue;
        }

        try {
          this.logger.log(`Updating last synced at date for integration mapping ${integrationMapping.id} to ${lastSyncedAt}`);
          await this.prisma.projectIntegrationMapping.update({
            where: { id: integrationMapping.id },
            data: {
              lastSyncedAt,
            },
          });
        } catch (error) {
          failedMappingIds.push(integrationMapping.id);
          this.logger.error(`Error updating lastSyncedAt for mapping ${integrationMapping.id}: ${error}`);
        }
      } catch (error) {
        failedMappingIds.push(integrationMapping.id);
        this.logger.error(`Error syncing mapping ${integrationMapping.id}: ${error}`);
      }
    }

    if (failedMappingIds.length > 0) {
      throw new InternalServerErrorException(
        `Failed to sync issues for ${failedMappingIds.length} integration mapping(s). Please retry.`,
      );
    }

    return {
      data: {
        organizationId,
        projectId,
        lastSyncedAt,
        updatedIssuesCount,
        createdIssuesCount,
      },
    };
  }

  async createIssueComments(
    projectId: string,
    issueId: string,
    organizationId: string,
    createCommentsDto: CreateIssueCommentsDto,
  ): Promise<IIssueComment[]> {
    // Validate that the issue exists and belongs to the project/organization
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: issueId,
        projectId,
        organizationId,
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId} for organization ${organizationId}`);
    }

    // Check for duplicate externalId values
    const existingComments = await this.prisma.issueComment.findMany({
      where: {
        issueId,
        externalId: {
          in: createCommentsDto.comments.map((comment) => comment.externalId).filter((id): id is string => id !== undefined),
        },
      },
    });

    if (existingComments.length > 0) {
      const duplicateIds = existingComments.map((comment) => comment.externalId);
      throw new BadRequestException(`Comments with external IDs already exist: ${duplicateIds.join(', ')}`);
    }

    // Create the comments
    const createdComments = await this.prisma.$transaction(
      createCommentsDto.comments.map((commentData) =>
        this.prisma.issueComment.create({
          data: {
            issueId,
            externalId: commentData.externalId || '',
            text: commentData.text,
            createdAt: new Date(commentData.createdAt),
          },
        }),
      ),
    );

    this.logger.log(`Created ${createdComments.length} comments for issue ${issueId}`);

    // Return the created comments in the expected format
    return createdComments.map((comment) => ({
      id: comment.id,
      externalId: comment.externalId,
      text: comment.text,
      createdAt: comment.createdAt,
      issueId: comment.issueId,
    }));
  }

  async createIssueComment(issueId: string, externalId: string, text: string, createdAt: Date): Promise<IIssueComment> {
    // Check if comment already exists with this externalId
    const existingComment = await this.prisma.issueComment.findFirst({
      where: {
        issueId,
        externalId,
      },
    });

    if (existingComment) {
      this.logger.log(`Comment with external ID ${externalId} already exists for issue ${issueId}, skipping creation`);
      return existingComment;
    }

    const comment = await this.prisma.issueComment.create({
      data: {
        issueId,
        externalId,
        text,
        createdAt,
      },
    });

    this.logger.log(`Created comment ${comment.id} with external ID ${externalId} for issue ${issueId}`);

    return comment;
  }

  async updateIssueComment(issueId: string, externalId: string, text: string): Promise<IIssueComment | null> {
    const comment = await this.prisma.issueComment.findFirst({
      where: {
        issueId,
        externalId,
      },
    });

    if (!comment) {
      this.logger.log(`Comment with external ID ${externalId} not found for issue ${issueId}, skipping update`);
      return null;
    }

    const updatedComment = await this.prisma.issueComment.update({
      where: { id: comment.id },
      data: {
        text,
      },
    });

    this.logger.log(`Updated comment ${updatedComment.id} with external ID ${externalId} for issue ${issueId}`);

    return updatedComment;
  }

  async deleteIssueComment(issueId: string, externalId: string): Promise<void> {
    const comment = await this.prisma.issueComment.findFirst({
      where: {
        issueId,
        externalId,
      },
    });

    if (!comment) {
      this.logger.log(`Comment with external ID ${externalId} not found for issue ${issueId}, skipping deletion`);
      return;
    }

    await this.prisma.issueComment.delete({
      where: { id: comment.id },
    });

    this.logger.log(`Deleted comment ${comment.id} with external ID ${externalId} for issue ${issueId}`);
  }

  async createFeedback(projectId: string, issueId: string, organizationId: string, createFeedbackDto: CreateFeedbackDto): Promise<IFeedback> {
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: issueId,
        projectId,
        organizationId,
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId} for organization ${organizationId}`);
    }

    const project = await this.prisma.project.findUnique({
      where: {
        id: issue.projectId,
      },
      include: {
        organization: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found for organization ${organizationId}`);
    }

    const user = this.requestContextService.getUser();

    const feedback = await this.prisma.feedback.create({
      data: {
        issueId,
        authorId: user?.id || '',
        sentiment: createFeedbackDto.sentiment,
        text: createFeedbackDto.text,
      },
    });

    this.logger.log(`Created feedback ${feedback.id} for issue ${issueId}`);

    // Emit stats event for incrementing feedback counter
    this.eventEmitter.emit(STATS_EVENTS.FEEDBACK_GIVEN, {
      organizationId,
      sentiment: createFeedbackDto.sentiment as 'positive' | 'negative' | 'neutral',
    });

    await this.trackFeedbackAnalytics(issueId, organizationId, projectId, createFeedbackDto);

    const resolveUrl = this.urlService.buildResolveItemUrl(project.organization.slug, project.slug, issue.id, 'fix');
    const sendingOptions = {
      resolveUrl,
      user,
      project,
    };

    await this.baseSlackService.sendFeedbackSlackNotification(issue, feedback, sendingOptions);

    // Return the created feedback in the expected format
    return {
      id: feedback.id,
      sentiment: feedback.sentiment,
      text: feedback.text,
      authorId: feedback.authorId,
      issueId: feedback.issueId,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
    };
  }

  async getSignedUrl(issueId: string, filePath: string): Promise<string> {
    // ensure that the filePath is of the issue details
    const issueDetailsArray = await this.prisma.issueDetails.findMany({
      where: { issueId },
    });

    for (const issueDetails of issueDetailsArray) {
      if (!issueDetails) {
        throw new NotFoundException(`Issue details not found for issue ${issueId}`);
      }

      const issueDetailsJson = JSON.stringify(issueDetails);
      // search for the file path in the issue details json
      const hasFilePath = issueDetailsJson.includes(filePath);

      if (hasFilePath) {
        const signedUrl = await this.cloudStorageService.generateSignedUrl(filePath);
        return signedUrl;
      }
    }

    throw new NotFoundException(`File path not found in issue details for issue ${issueId} and filePath ${filePath}`);
  }

  traverseForStoragePath(obj: any, filePath: string): boolean {
    if (obj === null || obj === undefined) {
      return false;
    }

    // Check if current object has the properties we're looking for
    if (typeof obj === 'object') {
      // Check for code_storage_path, output_storage_path, or report_storage_path properties
      if (obj.code_storage_path === filePath || obj.output_storage_path === filePath || obj.report_storage_path === filePath) {
        return true;
      }

      // If it's an array, traverse each element
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (this.traverseForStoragePath(item, filePath)) {
            return true;
          }
        }
      } else {
        // If it's an object, traverse each property
        for (const key in obj) {
          if (Object.hasOwn(obj, key)) {
            if (this.traverseForStoragePath(obj[key], filePath)) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }

  async getFile(issueId: string, filePath: string): Promise<{ buffer: Buffer; metadata: any }> {
    const issueDetailsArray = await this.prisma.issueDetails.findMany({
      where: { issueId },
    });

    for (const issueDetails of issueDetailsArray) {
      const hasFilePath = this.traverseForStoragePath(issueDetails, filePath);

      if (hasFilePath) {
        const fileData = await this.cloudStorageService.getFile(filePath);
        return fileData;
      }
    }

    throw new NotFoundException(`File path not found in issue details for issue ${issueId} and filePath ${filePath}`);
  }

  async archiveIssue(projectId: string, issueId: string, organizationId: string): Promise<{ isArchived: boolean; archivedAt: Date }> {
    // Verify the issue exists and belongs to the project/organization
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: issueId,
        projectId,
        organizationId,
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId} for organization ${organizationId}`);
    }

    // Check if already archived
    if (issue.isArchived) {
      throw new BadRequestException(`Issue ${issueId} is already archived`);
    }

    const archivedAt = new Date();

    const updatedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: {
        isArchived: true,
        archivedAt,
      },
    });

    this.logger.log(`Issue ${updatedIssue.key} (${issueId}) archived at ${archivedAt}`);

    const __meta = this.requestContextService.generateSSEMeta();

    await this.sseService.sendIssueEvent({
      event: 'issue_updated',
      data: updatedIssue,
      __meta,
    });

    return {
      isArchived: true,
      archivedAt,
    };
  }

  async unarchiveIssue(projectId: string, issueId: string, organizationId: string): Promise<{ isArchived: boolean; archivedAt: Date | null }> {
    // Verify the issue exists and belongs to the project/organization
    const issue = await this.prisma.issue.findFirst({
      where: {
        id: issueId,
        projectId,
        organizationId,
      },
    });

    if (!issue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId} for organization ${organizationId}`);
    }

    // Check if already unarchived
    if (!issue.isArchived) {
      throw new BadRequestException(`Issue ${issueId} is not archived`);
    }

    const updatedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: {
        isArchived: false,
        archivedAt: null,
      },
    });

    this.logger.log(`Issue ${updatedIssue.key} (${issueId}) unarchived`);

    const __meta = this.requestContextService.generateSSEMeta();

    await this.sseService.sendIssueEvent({
      event: 'issue_updated',
      data: updatedIssue,
      __meta,
    });

    return {
      isArchived: false,
      archivedAt: null,
    };
  }

  private async trackBugCreatedEvent(organizationId: string, projectId: string, issueId: string): Promise<void> {
    const issue = await this.prisma.issue.findUnique({
      where: { id: issueId },
      select: { source: true },
    });

    // Determine the issue source (integration or manual)
    const issueSource = issue?.source || 'manual';

    await this.analyticsService.trackEvent(
      {
        event: 'bug_created',
        properties: {
          issue_id: issueId,
          issue_source: issueSource as 'github' | 'jira' | 'asana' | 'trello' | 'linear' | 'manual',
        },
      },
      {
        organizationId,
        projectId,
      },
    );
  }

  private async trackFeedbackAnalytics(
    issueId: string,
    organizationId: string,
    projectId: string,
    createFeedbackDto: CreateFeedbackDto,
  ): Promise<void> {
    await this.analyticsService.trackEvent(
      {
        event: 'bug_sentiment_set',
        properties: {
          issue_id: issueId,
          sentiment: createFeedbackDto.sentiment as 'positive' | 'negative' | 'neutral',
        },
      },
      {
        organizationId,
        projectId,
      },
    );

    if (createFeedbackDto.text && createFeedbackDto.text.trim().length > 0) {
      await this.analyticsService.trackEvent(
        {
          event: 'bug_feedback_given',
          properties: {
            issue_id: issueId,
            feedback: createFeedbackDto.text,
          },
        },
        {
          organizationId,
          projectId,
        },
      );
    }
  }

  async cloneIssue(projectId: string, issueId: string, organizationId: string): Promise<IIssueListItem> {
    // First, get the original issue with all its related data
    const originalIssue = await this.prisma.issue.findFirst({
      where: {
        id: issueId,
        projectId,
        organizationId,
        isDeleted: false,
      },
      include: {
        details: true,
        comments: true,
        commit: true,
      },
    });

    if (!originalIssue) {
      throw new NotFoundException(`Issue ${issueId} not found in project ${projectId} for organization ${organizationId}`);
    }

    // Generate new key if original has one
    const newKey = originalIssue.key ? `clone-${originalIssue.key}` : undefined;

    // Create the cloned issue with modified data
    const clonedIssue = await this.prisma.issue.create({
      data: {
        key: newKey || '',
        projectId: originalIssue.projectId,
        organizationId: originalIssue.organizationId,
        title: `Cloned: ${originalIssue.title}`,
        text: originalIssue.text,
        html: originalIssue.html,
        agentResultStatus: originalIssue.agentResultStatus,
        agentProcessingStatus: originalIssue.agentProcessingStatus,
        // Clear integration-related fields
        issueUrl: null,
        source: null,
        rawData: originalIssue.rawData as any,
        createdById: originalIssue.createdById,
        cloudStorageInfo: originalIssue.cloudStorageInfo as any,
        commitId: originalIssue.commitId,
        isDeleted: false,
        isArchived: false,
        archivedAt: null,
      },
    });

    // Clone issue details if they exist
    if (originalIssue.details) {
      for (const details of originalIssue.details) {
        await this.prisma.issueDetails.create({
          data: {
            issueId: clonedIssue.id,
            fix: details.fix as any,
            reproductionScript: details.reproductionScript as any,
            investigationReport: details.investigationReport as any,
            modifiedUnitTests: details.modifiedUnitTests as any,
            existingUnitTests: details.existingUnitTests as any,
            newUnitTests: details.newUnitTests as any,
            regressionTests: details.regressionTests as any,
            acceptanceTests: details.acceptanceTests as any,
            fixTitle: details.fixTitle,
            fixRootCause: details.fixRootCause,
            fixOverview: details.fixOverview,
            slicerVersion: details.slicerVersion,
            reproductionConfidence: details.reproductionConfidence,
            fixPrDescription: details.fixPrDescription,
            fixCommitMessage: details.fixCommitMessage,
            solvedTaskStoragePath: details.solvedTaskStoragePath,
            abstentionReason: details.abstentionReason,
            createdAt: details.createdAt,
            updatedAt: details.updatedAt,
          },
        });
      }
    }

    // Clone issue comments if they exist
    if (originalIssue.comments && originalIssue.comments.length > 0) {
      await this.prisma.issueComment.createMany({
        data: originalIssue.comments.map((comment) => ({
          issueId: clonedIssue.id,
          externalId: comment.externalId,
          text: comment.text,
          createdAt: comment.createdAt,
        })),
      });
    }

    this.logger.log(`Issue ${originalIssue.key} (${issueId}) cloned to ${clonedIssue.key} (${clonedIssue.id})`);

    // Track bug_created analytics event for cloned issue
    await this.trackBugCreatedEvent(organizationId, projectId, clonedIssue.id);

    // Return the cloned issue in the expected format
    const lastDetails = originalIssue.details?.[originalIssue.details.length - 1];
    return {
      id: clonedIssue.id,
      key: clonedIssue.key,
      title: clonedIssue.title,
      aggregatedStatus: clonedIssue.aggregatedStatus as AggregatedIssueStatus,
      agentResultStatus: clonedIssue.agentResultStatus,
      agentProcessingStatus: clonedIssue.agentProcessingStatus,
      issueUrl: clonedIssue.issueUrl,
      projectId: clonedIssue.projectId,
      organizationId: clonedIssue.organizationId,
      createdAt: clonedIssue.createdAt,
      updatedAt: clonedIssue.updatedAt,
      cloudStorageInfo: clonedIssue.cloudStorageInfo,
      source: clonedIssue.source,
      commit: originalIssue.commit ? toResponseCommit(originalIssue.commit as PrismaCommit) : null,
      pullRequest: null, // No pull requests for cloned issues
      isArchived: clonedIssue.isArchived,
      slicerVersion: lastDetails?.slicerVersion,
    };
  }

  private extractFilePathFromBfr(bfr: any): string | null {
    // BFR must have filePath property
    if (!bfr?.filePath || typeof bfr.filePath !== 'string') {
      return null;
    }

    return bfr.filePath;
  }

  private async resolveBugFindingRule(projectId: string, filePath: string): Promise<any | null> {
    // Find bug finding rule that exactly matches the filePath
    const rule = await this.prisma.bugFindingRule.findFirst({
      where: {
        projectId,
        filePath: filePath,
      },
    });

    return rule;
  }

  async updateIssueFields(issueId: string, updateIssueDto: UpdateIssueDto): Promise<IIssue> {
    // Verify the issue exists and belongs to the project/organization
    const issue = await this.prisma.issue.findFirstOrThrow({
      where: {
        id: issueId,
      },
    });

    // If no fields to update, return the existing issue
    if (Object.keys(updateIssueDto).length === 0) {
      this.logger.log(`No fields to update for issue ${issueId}, returning existing issue`);
      return toIIssue(issue);
    }

    this.logger.log(`Updating issue ${issue.key} (${issueId}) with data: ${JSON.stringify(updateIssueDto)}`);
    const updatedIssue = await this.prisma.issue.update({
      where: { id: issueId },
      data: updateIssueDto,
    });

    const __meta = this.requestContextService.generateSSEMeta();

    await this.sseService.sendIssueEvent({
      event: 'issue_updated',
      data: updatedIssue,
      __meta,
    });

    return toIIssue(updatedIssue);
  }

  private buildSourceFilter(source?: string): any[] | null {
    if (source === undefined || source === null) {
      return null;
    }

    const validSources = ['bug_finder', 'manual', 'integration'];
    const sourceList = source
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // If no valid sources after filtering, throw error
    if (sourceList.length === 0) {
      throw new BadRequestException(`Invalid source values. Valid sources are: ${validSources.join(', ')}`);
    }

    // Validate sources and filter out invalid ones
    const validSourceList = sourceList.filter((s) => validSources.includes(s));

    if (validSourceList.length === 0) {
      throw new BadRequestException(`Invalid source values. Valid sources are: ${validSources.join(', ')}`);
    }

    // Build source filter conditions
    const sourceConditions = validSourceList
      .map((sourceType) => {
        switch (sourceType) {
          case 'bug_finder':
            return { source: 'bug_finder' };
          case 'manual':
            return { source: null };
          case 'integration':
            return {
              AND: [{ source: { not: null } }, { source: { not: 'bug_finder' } }],
            };
          default:
            return null;
        }
      })
      .filter((condition) => condition !== null);

    return sourceConditions.length > 0 ? sourceConditions : null;
  }
}
