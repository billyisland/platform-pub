import { redirect } from 'next/navigation'

export default function FollowersPage() {
  redirect('/workspace?overlay=network&tab=followers')
}
