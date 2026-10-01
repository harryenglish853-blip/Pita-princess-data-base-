export interface EmployeeAdminRow {
  id: string; employee_code: string; display_name: string; job_title: string | null; department: string | null;
  is_active: boolean; is_demo: boolean; created_at: string; last_activity_at: string | null; deactivated_at: string | null;
  has_pin: boolean; pin_locked_until: string | null; pin_set_at: string | null;
}
