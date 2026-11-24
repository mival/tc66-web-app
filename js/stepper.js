// Number inputs with arrow buttons. Stepper.enhance() adds a ▼ and a ▲ button to each input[data-stepper].
// The buttons use stepDown() and stepUp(), so min, max and step of the input apply.
// A button steps once on a click and repeats while the pointer holds it.
// The input gets 'input' and 'change' events, the same as after a keyboard edit.
(function (globalScope) {
  'use strict';

  const REPEAT_DELAY_MILLISECONDS = 400;
  const REPEAT_INTERVAL_MILLISECONDS = 90;
  const ICON_DOWN = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>';
  const ICON_UP = '<svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>';

  // The name of the field for the button labels: data-stepper, else the first text of the label.
  function fieldName(input) {
    if (input.dataset.stepper) return input.dataset.stepper;
    const label = input.closest('label');
    const text = label ? Array.from(label.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent).join(' ') : '';
    return text.replace(/\s+/g, ' ').trim() || 'value';
  }

  function step(input, direction) {
    if (input.disabled || input.readOnly) return;
    const before = input.value;
    try {
      if (direction > 0) input.stepUp();
      else input.stepDown();
    } catch {
      return; // The input has no valid step. Leave the value as it is.
    }
    if (input.value === before) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function makeButton(input, direction, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'step-button';
    button.innerHTML = direction > 0 ? ICON_UP : ICON_DOWN;
    button.setAttribute('aria-label', `${direction > 0 ? 'Increase' : 'Decrease'} ${name}`);
    button.disabled = input.disabled;
    let delayTimer = null;
    let repeatTimer = null;
    let repeated = false;
    const stop = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || button.disabled) return;
      repeated = false;
      stop();
      delayTimer = setTimeout(() => {
        repeated = true;
        step(input, direction);
        repeatTimer = setInterval(() => step(input, direction), REPEAT_INTERVAL_MILLISECONDS);
      }, REPEAT_DELAY_MILLISECONDS);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((type) => button.addEventListener(type, stop));
    // A click comes from a short press, Enter or Space. After a repeat, the click is not a new step.
    button.addEventListener('click', () => {
      if (repeated) {
        repeated = false;
        return;
      }
      step(input, direction);
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
    return button;
  }

  function enhanceInput(input) {
    if (input.closest('.stepper')) return;
    const name = fieldName(input);
    const label = input.closest('label');
    // A label names its first labelable child. The ▼ button comes first, so the label must point to the input.
    if (label && input.id) label.htmlFor = input.id;
    const wrapper = document.createElement('span');
    wrapper.className = 'stepper';
    input.replaceWith(wrapper);
    wrapper.append(makeButton(input, -1, name), input, makeButton(input, 1, name));
    // An error text for the range. CSS shows it only after interaction (:user-invalid).
    if (label && (input.min !== '' || input.max !== '')) {
      const error = document.createElement('span');
      error.className = 'field-error';
      const range = input.max !== '' ? `from ${input.min || 0} to ${input.max}` : `of ${input.min} or more`;
      error.textContent = `⚠ Enter a value ${range}.`;
      label.append(error);
    }
    // The mouse wheel must not change the value by accident.
    input.addEventListener('wheel', (event) => { if (document.activeElement === input) event.preventDefault(); }, { passive: false });
    // Keep the buttons disabled together with the input.
    new MutationObserver(() => {
      wrapper.querySelectorAll('.step-button').forEach((button) => { button.disabled = input.disabled; });
    }).observe(input, { attributes: true, attributeFilter: ['disabled'] });
  }

  function enhance(root = document) {
    root.querySelectorAll('input[type="number"][data-stepper]').forEach(enhanceInput);
  }

  // The value of the checked radio button in a segmented control (a fieldset with radio buttons).
  function segmentedValue(fieldset) {
    const checked = fieldset.querySelector('input[type="radio"]:checked');
    return checked ? checked.value : '';
  }

  globalScope.Stepper = { enhance, segmentedValue };
})(globalThis);
