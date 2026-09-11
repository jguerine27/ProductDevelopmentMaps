import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import Navbar from './Navbar';

/**
 * The bar mixes two kinds of section — Map switches Home's view in place, Home
 * and Collaborate navigate by callback — so "active" means the current
 * `activeForm` either way, and the controls are buttons, not anchors.
 *
 * It is presentational: `user`, `loading` and the callbacks arrive as props from
 * AppShell, so these tests need neither an auth provider nor a Router.
 */

const USER = { id: 'u1', display_name: 'Ada Lovelace', role: 'user', provider: 'firebase', orcid: '' };
const REVIEWER = { id: 'u2', display_name: 'Grace Hopper', role: 'reviewer', provider: 'orcid', orcid: '0000-0001' };

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
const labels = () => [...bar().querySelectorAll('button')]
    .map((button) => button.textContent.trim())
    .filter(Boolean);

it('shows the wordmark, the sections and the signed-out account controls in order', () => {
    show();

    expect(brand()).toBeInTheDocument();
    expect(labels()[0]).toBe(brand().textContent.trim());
    expect(labels().slice(1)).toEqual([
        'Home', 'Map', 'Collaborate', 'Sign in', 'Register',
    ]);
});

describe('the account slot', () => {
    it('renders a neutral placeholder while the session is still unknown', () => {
        show({ loading: true });

        // Showing Sign in / Register and swapping them for the account name a
        // moment later reads as a bug, and it is the first thing a visitor sees.
        expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
        expect(bar().querySelector('.pdm-nav-account-pending')).toBeInTheDocument();
    });

    it('wires Sign in and Register when signed out', () => {
        const onSignIn = jest.fn();
        const onRegister = jest.fn();
        show({ onSignIn, onRegister });

        fireEvent.click(link('Sign in'));
        expect(onSignIn).toHaveBeenCalled();

        fireEvent.click(link('Register'));
        expect(onRegister).toHaveBeenCalled();
    });

    it('swaps the signed-out pair for the account name and Log out', () => {
        const onLogout = jest.fn();
        show({ user: USER, onLogout });

        expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
        expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();

        fireEvent.click(link('Log out'));
        expect(onLogout).toHaveBeenCalled();
    });

    it('shows the name as quiet text, not a third coloured button', () => {
        show({ user: USER });

        const name = bar().querySelector('.pdm-nav-account-name');
        expect(name).toBeInTheDocument();
        expect(name.tagName).toBe('SPAN');
    });
});

describe('the Review link', () => {
    // Hiding it is a COURTESY, not a security control — the API enforces the
    // rule on every reviewer route. These tests assert the courtesy only.
    it('is hidden from signed-out visitors', () => {
        show();
        expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    });

    it('is hidden from a signed-in contributor', () => {
        show({ user: USER });
        expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    });

    it('appears for a reviewer and calls onReview', () => {
        const onReview = jest.fn();
        show({ user: REVIEWER, onReview });

        fireEvent.click(link('Review'));
        expect(onReview).toHaveBeenCalled();
    });
});

describe('navigation', () => {
    it('switches to the map in place', () => {
        const { setActiveForm } = show();

        fireEvent.click(link('Map'));
        expect(setActiveForm).toHaveBeenLastCalledWith('graph');
    });

    /**
     * Home used to be `form: 'home'`, which switched the map page to a bare
     * welcome heading and left the URL on /map. It is the landing route now, so
     * it must LEAVE rather than switch a view — hence both assertions.
     */
    it('navigates home rather than switching a view, from the link and the wordmark', () => {
        const onHome = jest.fn();
        const { setActiveForm } = show({ onHome });

        fireEvent.click(link('Home'));
        expect(onHome).toHaveBeenCalledTimes(1);

        fireEvent.click(brand());
        expect(onHome).toHaveBeenCalledTimes(2);

        expect(setActiveForm).not.toHaveBeenCalled();
    });

    it('renders the unbuilt section normally but leaves it inert', () => {
        const { setActiveForm } = show();

        const button = link('Collaborate');
        // Not disabled and not greyed: it says "coming", not "broken".
        expect(button).toBeEnabled();
        expect(button).toHaveClass('pdm-nav-link');
        fireEvent.click(button);

        expect(setActiveForm).not.toHaveBeenCalled();
    });

    it('does not switch the view when the account controls are used', () => {
        const { setActiveForm } = show({ onSignIn: jest.fn(), onRegister: jest.fn() });

        fireEvent.click(link('Sign in'));
        fireEvent.click(link('Register'));

        // They navigate; they do not change which section Home is showing.
        expect(setActiveForm).not.toHaveBeenCalled();
    });
});

describe('the active section', () => {
    it('marks the showing section and only that one', () => {
        show({ activeForm: 'graph', user: REVIEWER });

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

    // Map switches a view, Home navigates — the menu closes for either, so both
    // kinds of section are checked rather than whichever one happens to be first.
    it.each([
        ['Map', {}],
        ['Home', { onHome: () => {} }],
    ])('closes itself once %s is chosen', (label, props) => {
        show(props);
        const burger = screen.getByRole('button', { name: 'Menu' });

        fireEvent.click(burger);
        fireEvent.click(link(label));

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
