/** httpOnly cookie that holds the PIN-verified employee session token on a shared device. */
export const EMPLOYEE_COOKIE = 'pp_emp';
/** Maximum lifetime of the employee cookie; the database enforces its own (shorter) limits. */
export const EMPLOYEE_COOKIE_MAX_AGE = 12 * 60 * 60;
