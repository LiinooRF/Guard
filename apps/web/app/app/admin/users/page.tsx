import { redirect } from 'next/navigation';

export default function AdminUsersPage() {
  redirect('/app/admin?vista=personas');
}
