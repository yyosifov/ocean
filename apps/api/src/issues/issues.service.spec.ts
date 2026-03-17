import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentProcessingStatus, AgentResultStatus } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { CloudStorageService } from '../cloud-storage/cloud-storage.service';
import { LogicTasksCommunicationService } from '../cloud-storage/logic-tasks-communication.service';
import { RequestContextService } from '../common/services/request-context';
import { UrlService } from '../common/url/url.service';
import { ISSUE_EVENTS } from '../events/event-constants';
import { SseService } from '../events/sse.service';
import { AsanaService } from '../integrations/asana/asana.service';
import { AtlassianService } from '../integrations/atlassian/atlassian.service';
import { GithubIssuesService } from '../integrations/github/github-issues.service';
import { GitlabIssuesService } from '../integrations/gitlab/gitlab-issues.service';
import { LinearIssuesService } from '../integrations/linear/linear-issues.service';
import { NotionService } from '../integrations/notion/notion.service';
import { TrelloService } from '../integrations/trello/trello.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskStatus } from '../tasks/types';
import { IssueStatusService } from './issue-status.service';
import { IssuesService } from './issues.service';
import { ReviewSessionsService } from './review-sessions.service';
import { ReviewSessionState } from './types';

describe('IssuesService', () => {
  let service: IssuesService;
  let mockPrismaService: jest.Mocked<PrismaService>;
  let mockCloudStorageService: jest.Mocked<CloudStorageService>;
  let mockAsanaService: jest.Mocked<AsanaService>;
  let mockAtlassianService: jest.Mocked<AtlassianService>;
  let mockTrelloService: jest.Mocked<TrelloService>;
  let mockTasksService: jest.Mocked<TasksService>;
  let mockGithubIssuesService: jest.Mocked<GithubIssuesService>;
  let mockGitlabIssuesService: jest.Mocked<GitlabIssuesService>;
  let mockLinearIssuesService: jest.Mocked<LinearIssuesService>;
  let mockNotionService: jest.Mocked<NotionService>;
  let mockSseService: jest.Mocked<SseService>;
  let mockRequestContextService: jest.Mocked<RequestContextService>;
  let mockReviewSessionsService: jest.Mocked<ReviewSessionsService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;
  let mockAnalyticsService: jest.Mocked<AnalyticsService>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockIssueStatusService: jest.Mocked<IssueStatusService>;
  let mockLogicTasksCommunicationService: jest.Mocked<LogicTasksCommunicationService>;
  beforeEach(async () => {
    // Create mocks for all dependencies
    mockPrismaService = {
      issue: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      issueDetails: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      project: {
        findUnique: jest.fn(),
      },
      integration: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      organization: {
        findUnique: jest.fn(),
      },
      commit: {
        findMany: jest.fn(),
      },
      task: {
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      projectIntegrationMapping: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      issueComment: {
        deleteMany: jest.fn(),
      },
    } as any;

    mockIssueStatusService = {
      calculateAggregatedStatus: jest.fn(),
    } as any;

    mockCloudStorageService = {
      uploadFile: jest.fn(),
      downloadFile: jest.fn(),
      deleteFile: jest.fn(),
      uploadTaskFile: jest.fn(),
      getFileNameOnly: jest.fn(),
    } as any;

    mockAsanaService = {} as any;
    mockAtlassianService = {} as any;
    mockTrelloService = {} as any;

    mockTasksService = {
      createTask: jest.fn(),
      updateTask: jest.fn(),
    } as any;

    mockGithubIssuesService = {} as any;
    mockGitlabIssuesService = {} as any;
    mockLinearIssuesService = {} as any;
    mockNotionService = {} as any;
    mockSseService = {
      sendIssueEvent: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockRequestContextService = {
      getCurrentUser: jest.fn(),
      getCurrentOrganization: jest.fn(),
      generateSSEMeta: jest.fn().mockReturnValue({}),
      getUser: jest.fn(),
    } as any;

    mockReviewSessionsService = {
      createReviewSession: jest.fn(),
      getReviewSessionsByIssueDetail: jest.fn(),
      submitReviewSession: jest.fn(),
    } as any;

    mockEventEmitter = {
      emit: jest.fn(),
      emitAsync: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockAnalyticsService = {
      trackEvent: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
    } as any;

    mockConfigService = {
      get: jest.fn(),
      getOrThrow: jest.fn(),
    } as any;

    mockLogicTasksCommunicationService = {
      sendRequest: jest.fn(),
      uploadIssueFile: jest.fn(),
      uploadTaskFile: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IssuesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: CloudStorageService,
          useValue: mockCloudStorageService,
        },
        {
          provide: AsanaService,
          useValue: mockAsanaService,
        },
        {
          provide: AtlassianService,
          useValue: mockAtlassianService,
        },
        {
          provide: TrelloService,
          useValue: mockTrelloService,
        },
        {
          provide: TasksService,
          useValue: mockTasksService,
        },
        {
          provide: GithubIssuesService,
          useValue: mockGithubIssuesService,
        },
        {
          provide: GitlabIssuesService,
          useValue: mockGitlabIssuesService,
        },
        {
          provide: LinearIssuesService,
          useValue: mockLinearIssuesService,
        },
        {
          provide: NotionService,
          useValue: mockNotionService,
        },
        {
          provide: SseService,
          useValue: mockSseService,
        },
        {
          provide: RequestContextService,
          useValue: mockRequestContextService,
        },
        {
          provide: ReviewSessionsService,
          useValue: mockReviewSessionsService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
        {
          provide: AnalyticsService,
          useValue: mockAnalyticsService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: IssueStatusService,
          useValue: mockIssueStatusService,
        },
        {
          provide: LogicTasksCommunicationService,
          useValue: mockLogicTasksCommunicationService,
        },
        {
          provide: UrlService,
          useValue: {
            buildResolveItemUrl: jest.fn(
              (_org: string, _project: string, itemId: string, _itemType: string) => `https://api.example.com/api/v1/items/resolve?itemId=${itemId}`,
            ),
          },
        },
      ],
    }).compile();

    service = await module.resolve<IssuesService>(IssuesService);
  });

  describe('syncIssues', () => {
    const organizationId = 'org-1';
    const projectId = 'proj-1';
    const integrationMappingId = 'mapping-1';

    const integrationMapping = {
      id: integrationMappingId,
      projectId,
      integrationType: 'project_management',
      integration: {
        id: 'integration-1',
        organizationId,
        provider: 'github',
        type: 'project_management',
      },
    } as any;

    const issue1 = {
      title: 'Issue 1',
      text: null,
      html: null,
      key: 'ISSUE-1',
      projectId,
      organizationId,
      isCompleted: false,
      isForDeletion: false,
      source: 'github',
      issueUrl: 'https://example.com/issue/1',
    } as any;

    const issue2 = {
      title: 'Issue 2',
      text: null,
      html: null,
      key: 'ISSUE-2',
      projectId,
      organizationId,
      isCompleted: false,
      isForDeletion: false,
      source: 'github',
      issueUrl: 'https://example.com/issue/2',
    } as any;

    it('should not advance lastSyncedAt when any individual issue sync fails', async () => {
      mockPrismaService.projectIntegrationMapping.findMany.mockResolvedValue([integrationMapping]);

      jest.spyOn(service, 'fetchRecentIssues').mockResolvedValue([issue1, issue2]);

      mockPrismaService.issue.findFirst
        .mockResolvedValueOnce({ id: 'db-issue-1', key: issue1.key } as any)
        .mockResolvedValueOnce({ id: 'db-issue-2', key: issue2.key } as any);

      jest.spyOn(service, 'syncIssueUpdated')
        .mockRejectedValueOnce(new Error('db write failed'))
        .mockResolvedValueOnce(undefined);

      mockPrismaService.projectIntegrationMapping.update.mockResolvedValue({} as any);

      await expect(service.syncIssues(organizationId, projectId)).rejects.toThrow();

      expect(service.fetchRecentIssues).toHaveBeenCalledTimes(1);
      expect(service.syncIssueUpdated).toHaveBeenCalled();
      expect(mockPrismaService.projectIntegrationMapping.update).not.toHaveBeenCalled();
    });

    it('should advance lastSyncedAt when all issues sync successfully', async () => {
      mockPrismaService.projectIntegrationMapping.findMany.mockResolvedValue([integrationMapping]);

      jest.spyOn(service, 'fetchRecentIssues').mockResolvedValue([issue1, issue2]);

      mockPrismaService.issue.findFirst
        .mockResolvedValueOnce({ id: 'db-issue-1', key: issue1.key } as any)
        .mockResolvedValueOnce({ id: 'db-issue-2', key: issue2.key } as any);

      jest.spyOn(service, 'syncIssueUpdated').mockResolvedValue(undefined);

      mockPrismaService.projectIntegrationMapping.update.mockResolvedValue({} as any);

      await service.syncIssues(organizationId, projectId);

      expect(mockPrismaService.projectIntegrationMapping.update).toHaveBeenCalledTimes(1);
      expect(mockPrismaService.projectIntegrationMapping.update).toHaveBeenCalledWith({
        where: { id: integrationMappingId },
        data: { lastSyncedAt: expect.any(Date) },
      });
    });
  });

  describe('traverseForStoragePath', () => {
    const testFilePath = '/test/path/file.txt';

    describe('edge cases', () => {
      it('should return false for null input', () => {
        const result = service.traverseForStoragePath(null, testFilePath);
        expect(result).toBe(false);
      });

      it('should return false for undefined input', () => {
        const result = service.traverseForStoragePath(undefined, testFilePath);
        expect(result).toBe(false);
      });

      it('should return false for primitive values', () => {
        expect(service.traverseForStoragePath('string', testFilePath)).toBe(false);
        expect(service.traverseForStoragePath(123, testFilePath)).toBe(false);
        expect(service.traverseForStoragePath(true, testFilePath)).toBe(false);
      });

      it('should return false for empty object', () => {
        const result = service.traverseForStoragePath({}, testFilePath);
        expect(result).toBe(false);
      });

      it('should return false for empty array', () => {
        const result = service.traverseForStoragePath([], testFilePath);
        expect(result).toBe(false);
      });
    });

    describe('direct property matches', () => {
      it('should return true when code_storage_path matches', () => {
        const obj = {
          code_storage_path: testFilePath,
          other_property: 'value',
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should return true when output_storage_path matches', () => {
        const obj = {
          output_storage_path: testFilePath,
          other_property: 'value',
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should return true when both properties match', () => {
        const obj = {
          code_storage_path: testFilePath,
          output_storage_path: testFilePath,
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should return false when neither property matches', () => {
        const obj = {
          code_storage_path: '/different/path.txt',
          output_storage_path: '/another/path.txt',
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(false);
      });

      it('should return false when properties are missing', () => {
        const obj = {
          other_property: 'value',
          another_property: 123,
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(false);
      });
    });

    describe('nested object traversal', () => {
      it('should find match in nested object', () => {
        const obj = {
          level1: {
            level2: {
              code_storage_path: testFilePath,
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should find report_storage_path match in nested object', () => {
        const obj = {
          investigation_report: {
            report_storage_path: testFilePath,
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should find match in deeply nested object', () => {
        const obj = {
          a: {
            b: {
              c: {
                d: {
                  e: {
                    output_storage_path: testFilePath,
                  },
                },
              },
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should return false when no match in nested object', () => {
        const obj = {
          level1: {
            level2: {
              code_storage_path: '/different/path.txt',
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(false);
      });

      it('should handle mixed nested structure', () => {
        const obj = {
          level1: {
            code_storage_path: '/wrong/path.txt',
            level2: {
              output_storage_path: testFilePath,
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });
    });

    describe('array traversal', () => {
      it('should find match in array element', () => {
        const obj = [{ other_property: 'value' }, { code_storage_path: testFilePath }, { another_property: 123 }];
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should find match in nested array', () => {
        const obj = {
          items: [
            { name: 'item1' },
            {
              data: {
                output_storage_path: testFilePath,
              },
            },
          ],
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should return false when no match in array', () => {
        const obj = [{ code_storage_path: '/wrong/path.txt' }, { output_storage_path: '/another/wrong/path.txt' }];
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(false);
      });

      it('should handle empty array elements', () => {
        const obj = [null, undefined, {}, { code_storage_path: testFilePath }];
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should handle nested arrays', () => {
        const obj = [[{ code_storage_path: '/wrong/path.txt' }, { output_storage_path: testFilePath }]];
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });
    });

    describe('complex nested structures', () => {
      it('should find match in complex nested structure', () => {
        const obj = {
          metadata: {
            files: [
              {
                name: 'file1.txt',
                storage: {
                  code_storage_path: '/wrong/path.txt',
                },
              },
              {
                name: 'file2.txt',
                storage: {
                  output_storage_path: testFilePath,
                },
              },
            ],
            config: {
              settings: {
                paths: [
                  { type: 'code', path: '/another/path.txt' },
                  { type: 'output', path: testFilePath },
                ],
              },
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should handle circular reference-like structures', () => {
        const obj = {
          level1: {
            level2: {
              level3: {
                code_storage_path: testFilePath,
              },
            },
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });

      it('should handle mixed data types in nested structure', () => {
        const obj = {
          string_prop: 'value',
          number_prop: 123,
          boolean_prop: true,
          null_prop: null,
          undefined_prop: undefined,
          object_prop: {
            array_prop: [
              'string',
              456,
              false,
              {
                code_storage_path: testFilePath,
              },
            ],
          },
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });
    });

    describe('property name variations', () => {
      it('should only match exact property names', () => {
        const obj = {
          code_storage_paths: testFilePath, // plural
          codeStoragePath: testFilePath, // camelCase
          code_storage_path: testFilePath, // quoted
          output_storage_paths: testFilePath, // plural
          outputStoragePath: testFilePath, // camelCase
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true); // Should still match the exact property names
      });

      it('should handle properties with similar names', () => {
        const obj = {
          code_storage_path_old: testFilePath,
          code_storage_path_new: testFilePath,
          output_storage_path_backup: testFilePath,
          code_storage_path: testFilePath,
        };
        const result = service.traverseForStoragePath(obj, testFilePath);
        expect(result).toBe(true);
      });
    });

    describe('path matching', () => {
      it('should match exact path strings', () => {
        const exactPath = '/exact/path/match.txt';
        const obj = {
          code_storage_path: exactPath,
        };
        const result = service.traverseForStoragePath(obj, exactPath);
        expect(result).toBe(true);
      });

      it('should not match partial paths', () => {
        const fullPath = '/full/path/to/file.txt';
        const partialPath = '/full/path/to';
        const obj = {
          code_storage_path: fullPath,
        };
        const result = service.traverseForStoragePath(obj, partialPath);
        expect(result).toBe(false);
      });

      it('should handle empty string paths', () => {
        const obj = {
          code_storage_path: '',
          output_storage_path: '',
        };
        const result = service.traverseForStoragePath(obj, '');
        expect(result).toBe(true);
      });

      it('should handle paths with special characters', () => {
        const specialPath = '/path/with spaces & symbols!@#$%^&*().txt';
        const obj = {
          code_storage_path: specialPath,
        };
        const result = service.traverseForStoragePath(obj, specialPath);
        expect(result).toBe(true);
      });
    });
  });

  describe('updateIssueProcessingStatus', () => {
    it('should not update or emit events when status does not change', async () => {
      const existingIssue: any = {
        id: 'issue-1',
        key: 'ISSUE-1',
        agentProcessingStatus: AgentProcessingStatus.working,
      };

      await service.updateIssueProcessingStatus(existingIssue, TaskStatus.running);

      expect(mockPrismaService.issue.update).not.toHaveBeenCalled();
      expect(mockRequestContextService.generateSSEMeta).not.toHaveBeenCalled();
      expect(mockSseService.sendIssueEvent).not.toHaveBeenCalled();
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('should update the issue and emit events when status changes', async () => {
      const existingIssue: any = {
        id: 'issue-2',
        key: 'ISSUE-2',
        agentProcessingStatus: AgentProcessingStatus.not_started,
      };

      const issueUpdateMock = mockPrismaService.issue.update as unknown as jest.Mock;

      issueUpdateMock.mockResolvedValue({
        ...existingIssue,
        agentProcessingStatus: AgentProcessingStatus.working,
      });

      await service.updateIssueProcessingStatus(existingIssue, TaskStatus.running);

      expect(mockPrismaService.issue.update).toHaveBeenCalledWith({
        where: { id: existingIssue.id },
        data: { agentProcessingStatus: AgentProcessingStatus.working },
      });
      expect(mockRequestContextService.generateSSEMeta).toHaveBeenCalled();
      expect(mockSseService.sendIssueEvent).toHaveBeenCalledWith({
        event: 'issue_updated',
        data: expect.objectContaining({ agentProcessingStatus: AgentProcessingStatus.working }),
        __meta: expect.any(Object),
      });
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, {
        issueId: existingIssue.id,
      });
    });

    it('should update issue with error status and emit events when task fails', async () => {
      const existingIssue: any = {
        id: 'issue-5',
        key: 'ISSUE-5',
        agentProcessingStatus: AgentProcessingStatus.working,
        agentResultStatus: AgentResultStatus.no_fix_available,
      };

      const issueUpdateMock = mockPrismaService.issue.update as unknown as jest.Mock;

      issueUpdateMock.mockResolvedValue({
        ...existingIssue,
        agentProcessingStatus: AgentProcessingStatus.done,
        agentResultStatus: AgentResultStatus.error,
      });

      await service.updateIssueProcessingStatus(existingIssue, TaskStatus.failed);

      expect(mockPrismaService.issue.update).toHaveBeenCalledWith({
        where: { id: existingIssue.id },
        data: {
          agentProcessingStatus: AgentProcessingStatus.done,
          agentResultStatus: AgentResultStatus.error,
        },
      });
      expect(mockRequestContextService.generateSSEMeta).toHaveBeenCalled();
      expect(mockSseService.sendIssueEvent).toHaveBeenCalledWith({
        event: 'issue_updated',
        data: expect.objectContaining({
          agentProcessingStatus: AgentProcessingStatus.done,
          agentResultStatus: AgentResultStatus.error,
        }),
        __meta: expect.any(Object),
      });
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, {
        issueId: existingIssue.id,
      });
    });
  });

  describe('recomputeIssue', () => {
    const projectId = 'test-project-id';
    const issueId = 'test-issue-id';

    type MockProject = {
      id: string;
      organizationId: string;
      slug: string;
      repositories: Array<{
        name: string;
        latestCommit: {
          id: string;
        };
      }>;
    };

    type MockIssue = {
      id: string;
      key: string;
      projectId: string;
      source: string;
      agentProcessingStatus: AgentProcessingStatus;
      isArchived: boolean;
    };

    const project: MockProject = {
      id: projectId,
      organizationId: 'test-org-id',
      slug: 'test-project',
      repositories: [
        {
          name: 'test-repo',
          latestCommit: {
            id: 'commit-123',
          },
        },
      ],
    };

    beforeEach(() => {
      const projectFindUniqueMock = mockPrismaService.project.findUnique as unknown as jest.Mock;
      projectFindUniqueMock.mockResolvedValue(project);
      jest.spyOn(service, 'createIssueInCloudStorage').mockResolvedValue(undefined);
    });

    describe('bug_finder issues', () => {
      it('should allow recompute for bug_finder issue with not_started status without force', async () => {
        const bugFinderIssue: any = {
          id: issueId,
          key: 'BUG-1',
          projectId,
          source: 'bug_finder',
          agentProcessingStatus: AgentProcessingStatus.not_started,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(bugFinderIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).resolves.not.toThrow();

        expect(service.createIssueInCloudStorage).toHaveBeenCalledWith(project, bugFinderIssue, 'commit-123');
      });

      it('should block recompute for bug_finder issue with working status without force', async () => {
        const bugFinderIssue: any = {
          id: issueId,
          key: 'BUG-2',
          projectId,
          source: 'bug_finder',
          agentProcessingStatus: AgentProcessingStatus.working,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(bugFinderIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(
          `Issue ${issueId} is already in status ${AgentProcessingStatus.working}.`,
        );

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });

      it('should allow recompute for bug_finder issue with working status when force is true', async () => {
        const bugFinderIssue: any = {
          id: issueId,
          key: 'BUG-3',
          projectId,
          source: 'bug_finder',
          agentProcessingStatus: AgentProcessingStatus.working,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(bugFinderIssue);

        await expect(service.recomputeIssue(projectId, issueId, true)).resolves.not.toThrow();

        expect(service.createIssueInCloudStorage).toHaveBeenCalledWith(project, bugFinderIssue, 'commit-123');
      });

      it('should allow recompute for bug_finder issue with done status without force', async () => {
        const bugFinderIssue: MockIssue = {
          id: issueId,
          key: 'BUG-4',
          projectId,
          source: 'bug_finder',
          agentProcessingStatus: AgentProcessingStatus.done,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(bugFinderIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).resolves.not.toThrow();

        expect(service.createIssueInCloudStorage).toHaveBeenCalledWith(project, bugFinderIssue, 'commit-123');
      });
    });

    describe('regular issues (non-bug_finder)', () => {
      it('should block recompute for regular issue with not_started status without force', async () => {
        const regularIssue: any = {
          id: issueId,
          key: 'ISSUE-1',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.not_started,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(regularIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(
          `Issue ${issueId} is already in status ${AgentProcessingStatus.not_started}.`,
        );

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });

      it('should block recompute for regular issue with working status without force', async () => {
        const regularIssue: any = {
          id: issueId,
          key: 'ISSUE-2',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.working,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(regularIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(
          `Issue ${issueId} is already in status ${AgentProcessingStatus.working}.`,
        );

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });

      it('should allow recompute for regular issue with not_started status when force is true', async () => {
        const regularIssue: any = {
          id: issueId,
          key: 'ISSUE-3',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.not_started,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(regularIssue);

        await expect(service.recomputeIssue(projectId, issueId, true)).resolves.not.toThrow();

        expect(service.createIssueInCloudStorage).toHaveBeenCalledWith(project, regularIssue, 'commit-123');
      });

      it('should allow recompute for regular issue with done status without force', async () => {
        const regularIssue: MockIssue = {
          id: issueId,
          key: 'ISSUE-4',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.done,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(regularIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).resolves.not.toThrow();

        expect(service.createIssueInCloudStorage).toHaveBeenCalledWith(project, regularIssue, 'commit-123');
      });

      it('should include organizationId when tracking improve_fix event for pending review session', async () => {
        type MockIssueWithDetails = MockIssue & {
          details: Array<{
            id: string;
            solvedTaskStoragePath: string;
          }>;
        };

        type MockReviewSession = {
          id: string;
          issueDetailsId: string;
          createdById: string;
          state: ReviewSessionState;
          createdAt: Date;
        };

        const issueWithDetails: MockIssueWithDetails = {
          id: issueId,
          key: 'ISSUE-IMPROVE-1',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.done,
          isArchived: false,
          details: [
            {
              id: 'issue-details-1',
              solvedTaskStoragePath: 'solved/task/path.json',
            },
          ],
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(issueWithDetails);

        const reviewSession: MockReviewSession = {
          id: 'review-session-1',
          issueDetailsId: 'issue-details-1',
          createdById: 'user-1',
          state: ReviewSessionState.pending,
          createdAt: new Date(),
        };

        const getReviewSessionsMock = mockReviewSessionsService.getReviewSessionsByIssueDetail as unknown as jest.Mock;
        getReviewSessionsMock.mockResolvedValue([reviewSession]);

        jest.spyOn(service as any, 'createIssueImproveFixTask').mockResolvedValue(undefined);

        await expect(service.recomputeIssue(projectId, issueId, false)).resolves.not.toThrow();

        expect(mockAnalyticsService.trackEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'improve_fix',
            properties: expect.objectContaining({
              issue_id: issueId,
              review_session_id: 'review-session-1',
              issue_details_id: 'issue-details-1',
              force: false,
            }),
          }),
          expect.objectContaining({
            projectId,
            organizationId: project.organizationId,
          }),
        );

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
        expect(mockReviewSessionsService.submitReviewSession).toHaveBeenCalledWith('issue-details-1');
        expect((service as any).createIssueImproveFixTask).toHaveBeenCalled();
      });
    });

    describe('error cases', () => {
      it('should throw NotFoundException if project is not found', async () => {
        const issue: any = {
          id: issueId,
          key: 'ISSUE-5',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.done,
          isArchived: false,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(issue);

        const projectFindUniqueMock = mockPrismaService.project.findUnique as unknown as jest.Mock;
        projectFindUniqueMock.mockResolvedValue(null);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(`Project ${projectId} not found`);

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });

      it('should throw NotFoundException if issue is not found', async () => {
        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(null);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(`Issue ${issueId} not found in project ${projectId}`);

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });

      it('should throw BadRequestException if issue is archived', async () => {
        const archivedIssue: MockIssue = {
          id: issueId,
          key: 'ISSUE-6',
          projectId,
          source: 'github',
          agentProcessingStatus: AgentProcessingStatus.done,
          isArchived: true,
        };

        const issueFindUniqueMock = mockPrismaService.issue.findUnique as unknown as jest.Mock;
        issueFindUniqueMock.mockResolvedValue(archivedIssue);

        await expect(service.recomputeIssue(projectId, issueId, false)).rejects.toThrow(`Issue ${issueId} is archived`);

        expect(service.createIssueInCloudStorage).not.toHaveBeenCalled();
      });
    });
  });

  describe('updateIssue', () => {
    it('should skip updates and events when no relevant fields change', async () => {
      const existingIssue: any = {
        id: 'issue-3',
        key: 'ISSUE-3',
        text: 'Original description',
        agentResultStatus: AgentResultStatus.no_fix_available,
        agentProcessingStatus: AgentProcessingStatus.working,
        issueUrl: null,
      };

      const issueDetailsDetailed: any = {
        issue_status: 'no_result',
      };

      await service.updateIssue(existingIssue, issueDetailsDetailed, TaskStatus.running);

      expect(mockPrismaService.issue.update).not.toHaveBeenCalled();
      expect(mockRequestContextService.generateSSEMeta).not.toHaveBeenCalled();
      expect(mockSseService.sendIssueEvent).not.toHaveBeenCalled();
      expect(mockEventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('should update changed fields and emit events', async () => {
      const existingIssue: any = {
        id: 'issue-4',
        key: 'ISSUE-4',
        text: 'Old description',
        agentResultStatus: AgentResultStatus.no_fix_available,
        agentProcessingStatus: AgentProcessingStatus.not_started,
        issueUrl: 'https://example.com/issue',
      };

      const issueDetailsDetailed: any = {
        issue_status: 'ready_for_review',
      };

      const updatedIssue = {
        ...existingIssue,
        agentResultStatus: AgentResultStatus.validated_fix,
        agentProcessingStatus: AgentProcessingStatus.done,
        issueUrl: 'https://example.com/issue',
      };

      const issueUpdateMock = mockPrismaService.issue.update as unknown as jest.Mock;
      issueUpdateMock.mockResolvedValue(updatedIssue);

      const generateMetaMock = mockRequestContextService.generateSSEMeta as unknown as jest.Mock;
      const meta = { initiator: { userId: 'meta-user' } };
      generateMetaMock.mockReturnValue(meta);

      const result = await service.updateIssue(existingIssue, issueDetailsDetailed, TaskStatus.completed);

      expect(mockPrismaService.issue.update).toHaveBeenCalledWith({
        where: { id: existingIssue.id },
        data: {
          agentResultStatus: AgentResultStatus.validated_fix,
          agentProcessingStatus: AgentProcessingStatus.done,
        },
      });
      const updateCallArgs = issueUpdateMock.mock.calls[0][0];
      expect(updateCallArgs.data).not.toHaveProperty('text');
      expect(result.text).toBe(existingIssue.text);
      expect(mockRequestContextService.generateSSEMeta).toHaveBeenCalled();
      expect(mockSseService.sendIssueEvent).toHaveBeenCalledWith({
        event: 'issue_updated',
        data: updatedIssue,
        __meta: meta,
      });
      expect(mockEventEmitter.emitAsync).toHaveBeenCalledWith(ISSUE_EVENTS.RECALCULATE_AGGREGATED_STATUS, {
        issueId: existingIssue.id,
      });
    });
  });
});
