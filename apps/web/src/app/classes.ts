import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  APIRequestError,
  archiveClass as requestClassArchive,
  createClass,
  getClass,
  listClasses,
  restoreClass as requestClassRestore,
  rotateCSRFToken,
  updateClass as requestClassUpdate,
  type ClassStatus,
  type ClassVersionRequest,
  type ClassroomClass,
  type CreateClassRequest,
  type UpdateClassRequest,
} from "@tutorhub/api-client";
import { invalidateTenantAudit } from "./audit";
import { classFileQueryKeys } from "./classFiles";
import { invalidateTenantCapabilities } from "./tenantCapabilities";

const classPageSize = 20;

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL ?? "/api";
}

export type ClassStatusFilter = "all" | ClassStatus;

export const classQueryKeys = {
  all: ["classes"] as const,
  tenant: (tenantID: string) => ["classes", tenantID] as const,
  lists: (tenantID: string) => ["classes", tenantID, "list"] as const,
  list: (tenantID: string, status: ClassStatusFilter) =>
    ["classes", tenantID, "list", status] as const,
  detail: (tenantID: string, classID: string) =>
    ["classes", tenantID, "detail", classID] as const,
  rosterData: (tenantID: string, classID: string) =>
    [...classQueryKeys.detail(tenantID, classID), "roster"] as const,
  inviteCodes: (tenantID: string, classID: string) =>
    [...classQueryKeys.detail(tenantID, classID), "invite-codes"] as const,
};

function shouldRetryClassQuery(failureCount: number, error: Error) {
  return (
    failureCount < 1 &&
    !(
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    )
  );
}

export function useClassList(
  tenantID: string | undefined,
  status: ClassStatusFilter = "all",
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: classQueryKeys.list(tenantID ?? "inactive", status),
    queryFn: ({ pageParam, signal }) =>
      listClasses(
        {
          cursor: pageParam ?? undefined,
          limit: classPageSize,
          status: status === "all" ? undefined : status,
        },
        { baseUrl: getApiBaseUrl(), signal },
      ),
    enabled: enabled && Boolean(tenantID),
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    retry: shouldRetryClassQuery,
    staleTime: 20_000,
  });
}

export function useClassDetail(
  tenantID: string | undefined,
  classID: string | undefined,
) {
  return useQuery({
    queryKey: classQueryKeys.detail(
      tenantID ?? "inactive",
      classID ?? "invalid",
    ),
    queryFn: ({ signal }) =>
      getClass(classID ?? "", { baseUrl: getApiBaseUrl(), signal }),
    enabled: Boolean(tenantID && classID),
    retry: shouldRetryClassQuery,
    staleTime: 20_000,
  });
}

async function synchronizeClass(
  queryClient: QueryClient,
  tenantID: string,
  classroom: ClassroomClass,
  invalidateEnrollmentData = false,
) {
  await Promise.all([
    queryClient.cancelQueries({
      queryKey: classQueryKeys.lists(tenantID),
    }),
    queryClient.cancelQueries({
      exact: true,
      queryKey: classQueryKeys.detail(tenantID, classroom.id),
    }),
  ]);
  queryClient.setQueryData(
    classQueryKeys.detail(tenantID, classroom.id),
    classroom,
  );
  const invalidations = [
    queryClient.invalidateQueries({
      queryKey: classQueryKeys.lists(tenantID),
    }),
    queryClient.invalidateQueries({
      queryKey: classFileQueryKeys.list(tenantID, classroom.id),
    }),
  ];
  if (invalidateEnrollmentData) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: classQueryKeys.rosterData(tenantID, classroom.id),
      }),
      queryClient.invalidateQueries({
        exact: true,
        queryKey: classQueryKeys.inviteCodes(tenantID, classroom.id),
      }),
    );
  }
  await Promise.all(invalidations);
}

export interface CreateClassVariables {
  input: CreateClassRequest;
  /**
   * Activate the freshly created draft (`version: 1`) right away. Activation
   * failures never discard the created class: the draft is still returned.
   */
  activate?: boolean;
}

export interface CreateClassResult {
  classroom: ClassroomClass;
  activationError: Error | null;
}

export function useCreateClass(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation<CreateClassResult, Error, CreateClassVariables>({
    mutationFn: async ({ activate = false, input }) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      const created = await createClass(input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
      if (!activate || created.status !== "draft") {
        return { classroom: created, activationError: null };
      }
      try {
        const activationCSRF = await rotateCSRFToken({
          baseUrl: getApiBaseUrl(),
        });
        const activated = await requestClassUpdate(
          created.id,
          { expected_version: created.version, status: "active" },
          activationCSRF.csrf_token,
          { baseUrl: getApiBaseUrl() },
        );
        return { classroom: activated, activationError: null };
      } catch (error) {
        return {
          classroom: created,
          activationError:
            error instanceof Error ? error : new Error("activation_failed"),
        };
      }
    },
    onSuccess: async ({ classroom }) => {
      if (!tenantID) {
        return;
      }
      await synchronizeClass(queryClient, tenantID, classroom);
    },
    onSettled: () =>
      Promise.all([
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
  });
}

interface UpdateClassVariables {
  classID: string;
  input: UpdateClassRequest;
}

export function useUpdateClass(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ classID, input }: UpdateClassVariables) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return requestClassUpdate(classID, input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: async (updated) => {
      if (!tenantID) {
        return;
      }
      await synchronizeClass(queryClient, tenantID, updated);
    },
    onSettled: (_updated, error, { classID }) =>
      Promise.all([
        error && tenantID
          ? queryClient.invalidateQueries({
              exact: true,
              queryKey: classQueryKeys.detail(tenantID, classID),
            })
          : Promise.resolve(),
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
  });
}

interface ClassVersionVariables {
  classID: string;
  input: ClassVersionRequest;
}

export function useArchiveClass(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ classID, input }: ClassVersionVariables) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return requestClassArchive(classID, input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: async (archived) => {
      if (!tenantID) {
        return;
      }
      await synchronizeClass(queryClient, tenantID, archived, true);
    },
    onSettled: (_archived, error, { classID }) =>
      Promise.all([
        error && tenantID
          ? queryClient.invalidateQueries({
              exact: true,
              queryKey: classQueryKeys.detail(tenantID, classID),
            })
          : Promise.resolve(),
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
  });
}

export function useRestoreClass(tenantID: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ classID, input }: ClassVersionVariables) => {
      const csrf = await rotateCSRFToken({ baseUrl: getApiBaseUrl() });
      return requestClassRestore(classID, input, csrf.csrf_token, {
        baseUrl: getApiBaseUrl(),
      });
    },
    onSuccess: async (restored) => {
      if (!tenantID) {
        return;
      }
      await synchronizeClass(queryClient, tenantID, restored, true);
    },
    onSettled: (_restored, error, { classID }) =>
      Promise.all([
        error && tenantID
          ? queryClient.invalidateQueries({
              exact: true,
              queryKey: classQueryKeys.detail(tenantID, classID),
            })
          : Promise.resolve(),
        invalidateTenantAudit(queryClient, tenantID),
        invalidateTenantCapabilities(queryClient, tenantID),
      ]),
    retry: false,
  });
}
