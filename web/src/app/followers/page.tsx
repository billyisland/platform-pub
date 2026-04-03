import { redirect } from 'next/navigation'

export default function FollowersPage() {
  redirect('/following?tab=followers')
}
