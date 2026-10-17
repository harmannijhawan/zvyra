import { SpeedInsights } from '@vercel/speed-insights/react'
import { usePlatform } from './lib/platform'
import { Nav } from './sections/Nav'
import { Hero } from './sections/Hero'
import { Experience } from './sections/Experience'
import { SayRibbon } from './sections/SayRibbon'
import { Features } from './sections/Features'
import { Downloads } from './sections/Downloads'
import { FinalCta, Footer } from './sections/Closing'

export function App() {
  const platform = usePlatform()
  return (
    <>
      <a className="skip" href="#download">Skip to downloads</a>
      <Nav platform={platform} />
      <main>
        <Hero platform={platform} />
        <SayRibbon />
        <Experience />
        <Features />
        <Downloads platform={platform} />
        <FinalCta platform={platform} />
      </main>
      <Footer />
      <SpeedInsights />
    </>
  )
}
