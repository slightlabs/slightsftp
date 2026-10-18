/**
 * @jest-environment jsdom
 *
 * gui-login.test.ts — drives the REAL desktop login window (src/login.html and
 * its inline script) in jsdom with a fake ipcRenderer.
 */
import * as fs from 'fs';
import * as path from 'path';

const ipcRenderer = { invoke: jest.fn() };
const realSetImmediate: (cb: () => void) => void = jest.requireActual('timers').setImmediate;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(r => realSetImmediate(r)); };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const username = () => $<HTMLInputElement>('username');
const password = () => $<HTMLInputElement>('password');
const loginBtn = () => $<HTMLButtonElement>('loginBtn');
const error = () => $('errorMessage');

const submitWith = async (user: string, pass: string) => {
  username().value = user;
  password().value = pass;
  $('loginForm').dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
};

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  (window as any).require = (mod: string) => {
    if (mod === 'electron') return { ipcRenderer };
    throw new Error(`Cannot find module '${mod}'`);
  };
  (window as any).close = jest.fn();

  const html = fs.readFileSync(path.join(__dirname, '..', 'login.html'), 'utf8');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  document.documentElement.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/, '');
  const script = document.createElement('script');
  script.textContent = inline;
  document.body.appendChild(script);
});

afterAll(() => jest.useRealTimers());

beforeEach(() => {
  ipcRenderer.invoke.mockReset();
  (window.close as jest.Mock).mockClear();
});

describe('Login window GUI (login.html)', () => {
  test('renders the sign-in form', () => {
    expect(username()).toBeTruthy();
    expect(password().type).toBe('password');
    expect(loginBtn().textContent!.trim()).toBe('Sign In');
  });

  test('requires both username and password before calling the backend', async () => {
    await submitWith('admin', '');
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(error().textContent).toBe('Please enter both username and password');
    expect(error().classList.contains('show')).toBe(true);

    jest.advanceTimersByTime(3000);
    expect(error().classList.contains('show')).toBe(false);
  });

  test('trims the username and sends credentials to authenticate-user', async () => {
    ipcRenderer.invoke.mockResolvedValue({ success: true });
    await submitWith('  admin  ', 'admin123');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('authenticate-user', 'admin', 'admin123');
  });

  test('successful login closes the login window', async () => {
    ipcRenderer.invoke.mockResolvedValue({ success: true });
    await submitWith('admin', 'admin123');
    expect(window.close).toHaveBeenCalled();
  });

  test('disables the form while the request is in flight', async () => {
    let resolve!: (v: any) => void;
    ipcRenderer.invoke.mockReturnValue(new Promise(r => { resolve = r; }));
    username().value = 'admin';
    password().value = 'pw';
    $('loginForm').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(loginBtn().disabled).toBe(true);
    expect(loginBtn().textContent).toBe('Signing in...');
    expect(username().disabled).toBe(true);
    resolve({ success: false, error: 'nope' });
    await flush();
    expect(loginBtn().disabled).toBe(false);
  });

  test('failed login shows the backend error, re-enables the form and clears the password', async () => {
    ipcRenderer.invoke.mockResolvedValue({ success: false, error: 'Invalid username or password' });
    await submitWith('admin', 'wrong');
    expect(error().textContent).toBe('Invalid username or password');
    expect(window.close).not.toHaveBeenCalled();
    expect(loginBtn().disabled).toBe(false);
    expect(loginBtn().textContent).toBe('Sign In');
    expect(username().disabled).toBe(false);
    expect(password().value).toBe('');
  });

  test('an IPC exception shows a generic error', async () => {
    ipcRenderer.invoke.mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await submitWith('admin', 'pw');
    expect(error().textContent).toBe('An error occurred. Please try again.');
    expect(loginBtn().disabled).toBe(false);
  });

  test('pressing Enter in the password field submits', async () => {
    ipcRenderer.invoke.mockResolvedValue({ success: true });
    username().value = 'admin';
    password().value = 'admin123';
    password().dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('authenticate-user', 'admin', 'admin123');
  });

  test('the close button closes the window', () => {
    $('closeButton').click();
    expect(window.close).toHaveBeenCalled();
  });

  describe('forced password change', () => {
    const changeForm = () => $<HTMLFormElement>('changePasswordForm');
    const submitChange = async (pw: string, confirm = pw) => {
      $<HTMLInputElement>('newPassword').value = pw;
      $<HTMLInputElement>('confirmPassword').value = confirm;
      changeForm().dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
    };

    test('is hidden until the backend requires it', () => {
      expect(changeForm().hidden).toBe(true);
    });

    test('a login that requires a password change swaps in the change form', async () => {
      ipcRenderer.invoke.mockResolvedValue({ success: true, requirePasswordChange: true });
      await submitWith('admin', 'admin123');
      expect(window.close).not.toHaveBeenCalled();
      expect($('loginForm').hidden).toBe(true);
      expect(changeForm().hidden).toBe(false);
    });

    test('validates length and confirmation locally', async () => {
      await submitChange('short');
      expect(error().textContent).toMatch(/at least 8 characters/);
      await submitChange('LongEnough1', 'Different1');
      expect(error().textContent).toBe('The passwords do not match');
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    test('shows the backend error when the new password is refused', async () => {
      ipcRenderer.invoke.mockResolvedValue({ success: false, error: 'Choose a password other than the default one' });
      await submitChange('admin123x');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('set-first-login-password', 'admin123x');
      expect(error().textContent).toBe('Choose a password other than the default one');
      expect($<HTMLButtonElement>('changePasswordBtn').disabled).toBe(false);
      expect(window.close).not.toHaveBeenCalled();
    });

    test('an accepted new password continues to the dashboard', async () => {
      ipcRenderer.invoke.mockResolvedValue({ success: true });
      await submitChange('Brand-New-Pass1');
      expect(ipcRenderer.invoke).toHaveBeenCalledWith('set-first-login-password', 'Brand-New-Pass1');
      expect(window.close).toHaveBeenCalled();
    });
  });
});
