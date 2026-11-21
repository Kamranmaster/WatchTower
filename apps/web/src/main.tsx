import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ME_KEY } from './hooks/useAuth';
import { ApiError } from './lib/api';
import './index.css';

/** Any 401 means the session expired: mark the user logged out so the route guard sends them to /login. */
const onApiError = (error: Error) => {
  if (error instanceof ApiError && error.status === 401) {
    queryClient.setQueryData(ME_KEY, null);
  }
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: {
      // Don't retry client errors (401/403/404) — only network blips and 5xx.
      retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
