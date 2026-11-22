import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { loginSchema, registerSchema } from '@monitorly/contracts/api';
import { useLogin, useRegister } from '../hooks/useAuth';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError, errorMessage } from '../lib/api';
import { focusFirstInvalid, validate } from '../lib/validation';
import { Alert, Button, Card, TextField } from '../components/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const isRegister = mode === 'register';
  usePageTitle(isRegister ? 'Create your account' : 'Log in');
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  const login = useLogin();
  const register = useRegister();
  const mutation = isRegister ? register : login;

  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const values = isRegister ? { name, email, password } : { email, password };
  const clientErrors = attempted ? validate(isRegister ? registerSchema : loginSchema, values) : {};
  const error = mutation.error;
  const serverErrors = error instanceof ApiError ? error.fieldErrors : {};
  const fieldError = (field: string) => clientErrors[field] ?? serverErrors[field];
  // Show the top-level message only when it isn't already shown next to a field.
  const formError = error && Object.keys(serverErrors).length === 0 ? errorMessage(error) : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (Object.keys(validate(isRegister ? registerSchema : loginSchema, values)).length > 0) {
      focusFirstInvalid(formRef.current);
      return;
    }
    const onSuccess = () => navigate(redirectTo, { replace: true });
    const onError = () => focusFirstInvalid(formRef.current);
    if (isRegister) register.mutate({ name, email, password }, { onSuccess, onError });
    else login.mutate({ email, password }, { onSuccess, onError });
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div aria-hidden="true" className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-lg bg-indigo-600 font-bold text-white">
            M
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{isRegister ? 'Create your account' : 'Welcome back'}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {isRegister ? 'Start watching websites for the changes you care about.' : 'Log in to your monitors.'}
          </p>
        </div>

        <Card>
          <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate aria-label={isRegister ? 'Create account' : 'Log in'}>
            {formError && <Alert>{formError}</Alert>}
            {isRegister && (
              <TextField
                label="Name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={fieldError('name')}
                required
              />
            )}
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldError('email')}
              required
            />
            <div className="relative">
              <TextField
                label="Password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldError('password')}
                hint={isRegister ? 'At least 8 characters.' : undefined}
                required
                aside={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-pressed={showPassword}
                    className="rounded text-xs font-medium text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600"
                  >
                    {showPassword ? 'Hide password' : 'Show password'}
                  </button>
                }
              />
            </div>
            <Button type="submit" className="w-full" loading={mutation.isPending}>
              {isRegister ? 'Create account' : 'Log in'}
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-slate-600">
          {isRegister ? 'Already have an account? ' : 'New to Monitorly? '}
          <Link to={isRegister ? '/login' : '/register'} state={location.state} className="font-medium text-indigo-700 hover:text-indigo-600">
            {isRegister ? 'Log in' : 'Create an account'}
          </Link>
        </p>
      </div>
    </main>
  );
}
