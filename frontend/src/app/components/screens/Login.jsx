import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Leaf, SunMedium, Zap, ShieldCheck, Factory } from 'lucide-react';

const ADMIN_ACCOUNTS = [
  {
    username: 'Scheduling_VPPL',
    password: 'Scheduling@vppl54',
    name: 'Scheduling Admin',
    title: 'Administrator',
    role: 'admin',
  },
  {
    username: 'IT_VPPL',
    password: 'IT@vppl54',
    name: 'IT Admin',
    title: 'Administrator',
    role: 'admin',
  },
];

const INTERN_ACCOUNT = {
  empId: 'INTERN',
  username: 'intern',
  password: 'intern',
  name: 'Intern',
  title: 'Intern',
  role: 'member',
};

const TEAM_ACCOUNTS = [
  { empId: 'VPPL6127', name: 'Pooja Patil', title: 'Executive', birthYear: 1995, role: 'member' },
  { empId: 'VPPL6131', name: 'Dhiraj Ganvir', title: 'Executive', birthYear: 2000, role: 'member' },
  { empId: 'VPPL6125', name: 'Kaustubh Shah', title: 'Sr. Engr. Operations', birthYear: 1999, role: 'member' },
  { empId: 'VPPL6128', name: 'Shraddha Thakre', title: 'Graduate Engineer Trainee', birthYear: 2002, role: 'member' },
  { empId: 'VPPL6123', name: 'Ashish Jha', title: 'Lead Manager Operations', birthYear: 1999, role: 'member' },
  { empId: 'VPPL6124', name: 'Aditya Kamble', title: 'Sr. Engg. BD and O&M', birthYear: 1998, role: 'member' },
  { empId: 'VPPL6126', name: 'Ashwini Malkar', title: 'Senior Executive', birthYear: 1995, role: 'member' },
  { empId: 'VPPL6136', name: 'Vinayak Kariyattina', title: 'Graduate Engineer Trainee', birthYear: 2004, role: 'member' },
  { empId: 'VPPL6137', name: 'Prabhat Gupta', title: 'Graduate Engineer Trainee', birthYear: 2004, role: 'member' },
];

const AUTH_DAY_KEY = 'vedanjay-auth-day';
const REMEMBER_ME_KEY = 'vedanjay-remember-me';
const SAVED_CREDENTIALS_KEY = 'vedanjay-saved-credentials';
const getIstDateKey = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const normalizeLoginUsername = (value) =>
  String(value || '').trim().replace(/\s+/g, '').toUpperCase();

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const shouldRemember = localStorage.getItem(REMEMBER_ME_KEY) === 'true';
      if (!shouldRemember) return;

      const raw = localStorage.getItem(SAVED_CREDENTIALS_KEY);
      if (!raw) return;

      const saved = JSON.parse(raw);
      if (typeof saved?.username === 'string') setUsername(saved.username);
      if (typeof saved?.password === 'string') setPassword(saved.password);
      setRememberMe(true);
    } catch {
      // Ignore storage/parse errors.
    }
  }, []);

  const persistAuth = (userData) => {
    localStorage.setItem('vedanjay-user', JSON.stringify(userData));
    localStorage.setItem('vedanjay-token', userData.token);
    localStorage.setItem(AUTH_DAY_KEY, getIstDateKey());
  };

  const persistRememberedCredentials = () => {
    try {
      if (!rememberMe) {
        localStorage.removeItem(REMEMBER_ME_KEY);
        localStorage.removeItem(SAVED_CREDENTIALS_KEY);
        return;
      }

      localStorage.setItem(REMEMBER_ME_KEY, 'true');
      localStorage.setItem(
        SAVED_CREDENTIALS_KEY,
        JSON.stringify({
          username: String(username ?? ''),
          password: String(password ?? ''),
        })
      );
    } catch {
      // Ignore storage errors.
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!username || !password) {
      setError('Please enter both username and password');
      return;
    }

    setIsLoading(true);

    setTimeout(() => {
      const normalizedUsername = normalizeLoginUsername(username);
      const normalizedPassword = String(password || '');

      const matchedAdmin = ADMIN_ACCOUNTS.find(
        (account) =>
          normalizeLoginUsername(account.username) === normalizedUsername &&
          normalizedPassword === account.password
      );

      if (matchedAdmin) {
        const userData = {
          username: matchedAdmin.username,
          name: matchedAdmin.name,
          title: matchedAdmin.title,
          role: matchedAdmin.role,
          email: matchedAdmin.username,
          token: `vedanjay-token-${Date.now()}`,
        };

        persistAuth(userData);
        persistRememberedCredentials();
        onLogin(userData);
        setIsLoading(false);
        return;
      }

      const isInternLogin =
        normalizedUsername.toLowerCase() === INTERN_ACCOUNT.username.toLowerCase() &&
        normalizedPassword === INTERN_ACCOUNT.password;

      if (isInternLogin) {
        const userData = {
          username: INTERN_ACCOUNT.empId,
          empId: INTERN_ACCOUNT.empId,
          name: INTERN_ACCOUNT.name,
          title: INTERN_ACCOUNT.title,
          role: INTERN_ACCOUNT.role,
          email: INTERN_ACCOUNT.empId,
          token: `vedanjay-token-${Date.now()}`,
        };

        persistAuth(userData);
        persistRememberedCredentials();
        onLogin(userData);
        setIsLoading(false);
        return;
      }

      const matchedEmployee = TEAM_ACCOUNTS.find((account) => account.empId.toUpperCase() === normalizedUsername);
      if (!matchedEmployee) {
        setError('Unknown user. Use your Employee ID as username (example: VPPL6127).');
        setIsLoading(false);
        return;
      }

      const expectedPassword = `${matchedEmployee.empId}#${matchedEmployee.birthYear}`;
      if (normalizedPassword !== expectedPassword) {
        setError('Invalid password. Format: EMPID#BIRTHYEAR (example: VPPL6127#1995).');
        setIsLoading(false);
        return;
      }

      const userData = {
        username: matchedEmployee.empId,
        empId: matchedEmployee.empId,
        name: matchedEmployee.name,
        title: matchedEmployee.title,
        role: matchedEmployee.role,
        email: matchedEmployee.empId,
        token: `vedanjay-token-${Date.now()}`,
      };

      persistAuth(userData);
      persistRememberedCredentials();
      onLogin(userData);
      setIsLoading(false);
    }, 900);
  };

  return (
    <div className="min-h-screen flex items-center justify-center login-surface px-4 py-12 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-16 -left-10 w-80 h-80 rounded-full bg-emerald-400/15 blur-3xl" />
        <div className="absolute -bottom-16 -right-10 w-96 h-96 rounded-full bg-lime-300/10 blur-3xl" />
      </div>

      <div className="w-full max-w-5xl relative z-10">
        <div className="grid lg:grid-cols-2 gap-6 items-stretch">
          <div className="rounded-3xl border border-border bg-card/90 backdrop-blur p-8 lg:p-10 shadow-xl">
            <div className="flex items-center gap-4 mb-8">
              <img
                src="/vedanjay logo.png"
                alt="Vedanjay logo"
                className="w-16 h-16 rounded-2xl object-cover shadow-lg"
              />
              <div>
                <h1 className="text-2xl font-bold text-foreground">Vedanjay Power Control Dashboard</h1>
                <p className="text-sm text-muted-foreground">Energy Operations Center</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-200/60 dark:border-emerald-900/60 bg-gradient-to-r from-emerald-50 to-lime-50 dark:from-emerald-950/30 dark:to-lime-950/20 p-4">
                <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">Solar-first Monitoring</p>
                <p className="text-xs text-emerald-700/90 dark:text-emerald-400">Real-time schedule, meter and weather control for renewable operations.</p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border border-border bg-background p-3 text-center">
                  <SunMedium className="w-4 h-4 text-primary mx-auto mb-1" />
                  <p className="text-xs font-medium text-foreground">Solar Ops</p>
                </div>
                <div className="rounded-xl border border-border bg-background p-3 text-center">
                  <Leaf className="w-4 h-4 text-primary mx-auto mb-1" />
                  <p className="text-xs font-medium text-foreground">Green Energy</p>
                </div>
                <div className="rounded-xl border border-border bg-background p-3 text-center">
                  <Zap className="w-4 h-4 text-primary mx-auto mb-1" />
                  <p className="text-xs font-medium text-foreground">Live Control</p>
                </div>
              </div>
            </div>

            <div className="mt-8 space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>Single authorized admin access</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Factory className="w-4 h-4 text-emerald-500" />
                <span>Built for Vedanjay renewable power operations</span>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-3xl border border-border shadow-xl p-8 lg:p-10">
            <div className="mb-6">
              <p className="text-sm uppercase tracking-widest text-primary font-semibold">Admin Login</p>
              <h2 className="text-2xl font-bold text-foreground mt-2">Welcome Back</h2>
              <p className="text-sm text-muted-foreground mt-1">Sign in to manage Vedanjay schedule operations.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-muted-foreground mb-2">
                  Username / Employee ID
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Example: VPPL6127 or Scheduling_VPPL"
                  className="w-full px-4 py-3 bg-input-background border border-border text-foreground rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
                  disabled={isLoading}
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-muted-foreground mb-2">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="w-full px-4 py-3 bg-input-background border border-border text-foreground rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all pr-12"
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground select-none">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => {
                      const next = Boolean(e.target.checked);
                      setRememberMe(next);
                      if (!next) {
                        try {
                          localStorage.removeItem(REMEMBER_ME_KEY);
                          localStorage.removeItem(SAVED_CREDENTIALS_KEY);
                        } catch {
                          // Ignore storage errors.
                        }
                      }
                    }}
                    disabled={isLoading}
                    className="h-4 w-4 rounded border-border bg-input-background text-primary focus:ring-primary/50"
                  />
                  <span>Remember me</span>
                </label>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-300 text-sm">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl transition-all duration-200 hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <span>Sign In to Dashboard</span>
                )}
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-border">
              <p className="text-center text-sm text-muted-foreground">Secure Vedanjay Administrator Access</p>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
