/**
 * Centralized White-Label Branding Configuration
 *
 * Configures customer-facing brand identity across checkout-portal,
 * payment-api, and banking observers for AC-Pay (Alumni Cell Pay)
 * at KJ Somaiya College of Engineering.
 */
export const BRANDING_CONFIG = Object.freeze({
  businessName: 'Alumni Cell · KJ Somaiya College of Engineering',
  poweredBy: 'AC-Pay',
  appName: 'AC-Pay',
  supportEmail: 'alumnicell.engg@somaiya.edu',
  supportEmails: Object.freeze(['alumnicell.engg@somaiya.edu']),
  supportPhone: '+91 22 6644 9191',
  supportMobiles: Object.freeze(['+91 22 6644 9191']),
  logoUrl: null,
  primaryColor: '#A72B2A',
  sidebarNotice: 'KJ Somaiya College of Engineering · 256-Bit Bank Encryption',
  trustBadgeText: 'Verified Institute · Alumni Cell KJSSE',
  counterInstructions: 'Please visit the Alumni Cell registration desk and present this screen to the coordinator.',
  cardCounterInstructions: 'Please swipe, insert, or tap your card on the desk POS terminal at the registration desk.',
});
