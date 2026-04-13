import { redirect } from 'next/navigation'

export default function FollowersPage() {
  redirect('/network?tab=followers')
}
