import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Navbar from './Navbar';

/**
 * The bar switches Home's view rather than navigating, so "active" means the
 * current `activeForm` and the controls are buttons, not anchors.
 */

const show = (props = {}) => {
    const setActiveForm = jest.fn();
    const view = render(
        <Navbar setActiveForm={setActiveForm} activeForm="graph" {...props} />
    );
    return { ...view, setActiveForm };
};

const bar = () => screen.getByRole('navigation', { name: 'Main' });
const link = (name) => within(bar()).getByRole('button', { name });
/** By class, not by text — the wordmark is product naming and may be reworded. */
const brand = () => bar().querySelector('.pdm-nav-brand');

it('shows the wordmark, the four sections and the account controls in order', () => {
    show();

    const labels = [...bar().querySelectorAll('button')]
        .map((button) => button.textContent.trim())
        .filter(Boolean);

    expect(brand()).toBeInTheDocument();
    expect(labels[0]).toBe(brand().textContent.trim());
    expect(labels.slice(1)).toEqual([
        'Home', 'Map', 'Collaborate', 'Review', 'Sign in', 'Register',
    ]);
});

it('swaps the signed-out pair for Log out when a session exists', () => {
    const onLogout = jest.fn();
    show({ onLogout });

    // The app has a working signed-in state; showing Sign in / Register there
    // would strand a signed-in user with no way out.
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();

    fireEvent.click(link('Log out'));
    expect(onLogout).toHaveBeenCalled();
});

describe('navigation', () => {
    it('switches to the map and to home', () => {
        const { setActiveForm } = show();

        fireEvent.click(link('Map'));
        expect(setActiveForm).toHaveBeenLastCalledWith('graph');

        fireEvent.click(link('Home'));
        expect(setActiveForm).toHaveBeenLastCalledWith('home');

        fireEvent.click(brand());
        expect(setActiveForm).toHaveBeenLastCalledWith('home');
    });

    it('renders the unbuilt sections normally but leaves them inert', () => {
        const { setActiveForm } = show();

        for (const label of ['Collaborate', 'Review']) {
            const button = link(label);
            // Not disabled and not greyed: they say "coming", not "broken".
            expect(button).toBeEnabled();
            expect(button).toHaveClass('pdm-nav-link');
            fireEvent.click(button);
        }

        expect(setActiveForm).not.toHaveBeenCalled();
    });

    it('leaves Sign in and Register inert', () => {
        const { setActiveForm } = show();

        fireEvent.click(link('Sign in'));
        fireEvent.click(link('Register'));

        expect(setActiveForm).not.toHaveBeenCalled();
    });
});

describe('the active section', () => {
    it('marks the showing section and only that one', () => {
        show({ activeForm: 'graph' });

        expect(link('Map')).toHaveAttribute('aria-current', 'page');
        for (const label of ['Home', 'Collaborate', 'Review']) {
            expect(link(label)).not.toHaveAttribute('aria-current');
        }
    });

    it('follows the view as it changes', () => {
        const { rerender } = show({ activeForm: 'home' });
        expect(link('Home')).toHaveAttribute('aria-current', 'page');

        rerender(<Navbar setActiveForm={jest.fn()} activeForm="graph" />);
        expect(link('Map')).toHaveAttribute('aria-current', 'page');
        expect(link('Home')).not.toHaveAttribute('aria-current');
    });

    it('marks nothing when a section outside the bar is showing', () => {
        // The CRUD screens are no longer linked from here but can still render.
        show({ activeForm: 'delete' });

        expect(bar().querySelector('[aria-current]')).toBeNull();
    });
});

describe('narrow screens', () => {
    it('collapses behind a toggle that reports its state', () => {
        show();
        const burger = screen.getByRole('button', { name: 'Menu' });
        const menu = document.getElementById('pdm-nav-menu');

        expect(burger).toHaveAttribute('aria-expanded', 'false');
        expect(burger).toHaveAttribute('aria-controls', 'pdm-nav-menu');
        expect(menu).not.toHaveClass('is-open');

        fireEvent.click(burger);
        expect(burger).toHaveAttribute('aria-expanded', 'true');
        expect(menu).toHaveClass('is-open');
    });

    it('closes itself once a section is chosen', () => {
        show();
        const burger = screen.getByRole('button', { name: 'Menu' });

        fireEvent.click(burger);
        fireEvent.click(link('Home'));

        expect(burger).toHaveAttribute('aria-expanded', 'false');
    });

    it('stays open when an inert section is clicked', () => {
        show();
        const burger = screen.getByRole('button', { name: 'Menu' });

        fireEvent.click(burger);
        fireEvent.click(link('Collaborate'));

        // Nothing changed, so closing the menu would just lose the user's place.
        expect(burger).toHaveAttribute('aria-expanded', 'true');
    });
});
