import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('shows commands for opening a file and folder', () => {
    render(<App />);

    expect(screen.getByRole('button', { name: '打开文件' })).toBeVisible();
    expect(screen.getByRole('button', { name: '打开文件夹' })).toBeVisible();
  });
});
