import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginInput, RegisterInput, UpdateProfileInput, UserDto } from '@monitorly/contracts';
import { ApiError, api } from '../lib/api';

export const ME_KEY = ['me'] as const;

/** The logged-in user, or null when logged out. */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api<{ user: UserDto }>('/api/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api<{ user: UserDto }>('/api/auth/login', { method: 'POST', json: input }),
    onSuccess: ({ user }) => qc.setQueryData(ME_KEY, user),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RegisterInput) =>
      api<{ user: UserDto }>('/api/auth/register', { method: 'POST', json: input }),
    onSuccess: ({ user }) => qc.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Drop every cached query so the next user never sees the previous user's data.
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  });
}

/** Account settings: name, account-wide email alerts, default check interval. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateProfileInput) => (await api<{ user: UserDto }>('/api/auth/me', { method: 'PATCH', json: input })).user,
    onSuccess: (user) => qc.setQueryData(ME_KEY, user),
  });
}
