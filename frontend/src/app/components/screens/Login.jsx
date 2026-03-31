import { useState } from 'react';
import { Eye, EyeOff, Loader2, Moon, Sun, Leaf, SunMedium, Zap, ShieldCheck, Factory } from 'lucide-react';

const COMPANY_LOGIN_EMAIL = 'admin';
const COMPANY_LOGIN_PASSWORD = 'admin';

export default function Login({ onLogin, isDarkMode, toggleTheme }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Please enter both email and password');
      return;
    }

    setIsLoading(true);

    setTimeout(() => {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const isValidLogin =
        normalizedEmail === COMPANY_LOGIN_EMAIL.toLowerCase() && password === COMPANY_LOGIN_PASSWORD;

      if (isValidLogin) {
        const userData = {
          email: COMPANY_LOGIN_EMAIL,
          role: 'admin',
          name: 'Admin',
          token: `vedanjay-token-${Date.now()}`,
        };

        localStorage.setItem('vedanjay-user', JSON.stringify(userData));
        localStorage.setItem('vedanjay-token', userData.token);
        onLogin(userData);
      } else {
        setError('Invalid credentials. Please use the authorized admin account.');
      }
      setIsLoading(false);
    }, 900);
  };

  return (
    <div className="min-h-screen flex items-center justify-center login-surface px-4 py-12 relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-16 -left-10 w-80 h-80 rounded-full bg-emerald-400/15 blur-3xl" />
        <div className="absolute -bottom-16 -right-10 w-96 h-96 rounded-full bg-lime-300/10 blur-3xl" />
      </div>

      <button
        onClick={toggleTheme}
        className="absolute top-5 right-5 p-2 rounded-lg border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-all"
        aria-label="Toggle theme"
      >
        {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
      </button>

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
                <label htmlFor="email" className="block text-sm font-medium text-muted-foreground mb-2">
                  Admin Username
                </label>
                <input
                  id="email"
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin"
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
