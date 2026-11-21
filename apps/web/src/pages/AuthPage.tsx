import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useLogin, useRegister } from '../hooks/useAuth';
import { ApiError } from '../lib/api';
import { Alert, Button, Card, TextField } from '../components/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const login = useLogin();
  const register = useRegister();
  const mutation = isRegister ? register : login;

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const error = mutation.error;
  const fieldErrors = error instanceof ApiError ? error.fieldErrors : {};
  // Show the top-level message only when it isn't already shown next to a field.
  const formError = error && Object.keys(fieldErrors).length === 0 ? error.message : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const onSuccess = () => navigate(redirectTo, { replace: true });
    if (isRegister) register.mutate({ name, email, password }, { onSuccess });
    else login.mutate({ email, password }, { onSuccess });
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-indigo-600 font-bold text-white">M</div>
          <h1 className="text-2xl font-bold tracking-tight">{isRegister ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {isRegister ? 'Start watching websites for the changes you care about.' : 'Log in to your monitors.'}
          </p>
        </div>

        <Card>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {formError && <Alert>{formError}</Alert>}
            {isRegister && (
              <TextField label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors.name} required />
            )}
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              required
            />
            <TextField
              label="Password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              hint={isRegister ? 'At least 8 characters.' : undefined}
              required
            />
            <Button type="submit" className="w-full" loading={mutation.isPending}>
              {isRegister ? 'Create account' : 'Log in'}
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-slate-600">
          {isRegister ? 'Already have an account? ' : 'New to Monitorly? '}
          <Link to={isRegister ? '/login' : '/register'} state={location.state} className="font-medium text-indigo-600 hover:text-indigo-500">
            {isRegister ? 'Log in' : 'Create an account'}
          </Link>
        </p>
      </div>
    </div>
  );
}
