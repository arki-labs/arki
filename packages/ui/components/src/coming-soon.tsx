import { useTranslations } from '@arki/intl/next-client';

const messages = [
  "We're coming soon, but our procrastination skills are already here!",
  "Our website is like a fine wine, it's taking a while to mature. Coming soon!",
  "We're building this website with love, care, and a lot of coffee. Coming soon-ish!",
  "Our website is on a strict diet of code and caffeine. It'll be ready soon, we promise!",
  "We're putting the final touches on our website. It's like putting socks on a rooster, but we'll get there! Coming soon.",
  'Our website is like a ninja, silently sneaking up on you. Prepare to be amazed... soon!',
  "We're crafting this website like a master chef, and it's almost ready to serve. Coming soon to a browser near you!",
  'Our website is currently in the oven, baking to perfection. Coming soon, hot and fresh!',
  "We're building this website one brick at a time, like a digital Lego masterpiece. Coming soon, so stay tuned!",
  'Our website is like a slow-motion action hero, stylishly arriving soon to save the day (or at least your browsing experience)!',
  'This site is under construction, like my bank account!',
  'This site is under construction, like my diet!',
  'This site is under construction, like my love life!',
  'This site is under construction, like my car!',
  'This site is under construction, like my house!',
  'This site is under construction, like my job!',
  'This site is under construction, like my family!',
  'This site is under construction, like my friends!',
  'This site is under construction, like my health!',
  'This site is under construction, like my finances!',
  'This site is under construction, like my sleep!',
  'Under construction, just like my life decisions.',
  'We’re busy fighting internet dragons. Check back soon!',
  'This site is currently marinating. Please check back when fully seasoned.',
  'Our hamsters are on strike. Negotiations ongoing.',
  'We’re building something amazing. Or so our developer claims.',
  'Unless we get distracted by cat videos again.',
  'This site is currently being built by a team of highly skilled monkeys.',
  'Coding at caffeine speed. Send espresso.',
  'This space intentionally left blank. (But not for long!)',
  "Our developers are currently fighting a horde of angry semicolons. We'll be back once we've restored peace to the codebase.",
  "This website is like a fine wine... except it's not ready yet, and you can't drink it. Check back soon!",
  "Plot twist: The website isn't actually coming soon. This is the website. Just kidding, please come back later.",
  "Our hamsters are running as fast as they can on their wheels to power up this website. Unfortunately, they're on a coffee break right now.",
  "We're currently teaching our AI assistant to make better jokes than this one. Until then, you'll have to wait for the actual website.",
  'Breaking news: Website still under construction. In other news, water is wet, and cookies are delicious. More updates to follow.',
  "Website loading... Error 404: Patience not found. Don't worry, we're working on it faster than a cat chasing a laser pointer.",
  'Warning: This website contains high levels of potential. Side effects may include anticipation, repeated refreshing, and excessive use of the back button.',
  "Our team of highly trained monkeys is currently perfecting their HTML skills. They've mastered bananas but are still struggling with brackets.",
  "This website is like your friend who says they'll be ready in 5 minutes – except we're actually going to show up eventually.",
  "This website is currently being reviewed by a panel of fashion-conscious penguins wearing tiny bowties. They're very picky about font choices and keep demanding more fish.",
  "URGENT: Our entire development team has been transformed into rubber ducks. We're working on the antidote, but in the meantime, they can only respond with 'quack quack debug quack.'",
  "Loading website... please wait while we convince our code to stop running away with the server's coffee maker. They've formed an unusual bond we didn't see coming.",
  "ERROR 418: I'm actually a teapot pretending to be a website. My therapist says I need to be honest about my identity. Real website coming after my breakthrough.",
  "BREAKING: Our website took a gap year to 'find itself' backpacking through the cloud servers of Europe. Last seen taking selfies with a 404 error in Paris.",
  'Technical Difficulty: Our CSS got into a fistfight with JavaScript over who looks prettier. HTML is refusing to mediate. Send help and cookies.',
  "Website temporarily replaced by an interpretive dance performance by our binary code. Current show: '500 Internal Server Errors: A Tragic Ballet in Two Acts.'",
  'ALERT: Website has eloped with a calculator app. Currently honeymooning in Silicon Valley. Expected return date: When they run out of batteries.',
  'Our website is currently being rebuilt by a team of overachieving garden gnomes who demand creative control and better working conditions. Their union rep is tough.',
  "Loading... just kidding! We're actually teaching a group of retired mimes how to code. So far they've mastered invisible buttons and silent errors.",
];

export const ComingSoon = () => {
  const t = useTranslations('ComingSoon');

  const message = messages[Math.floor(Math.random() * messages.length)];
  return (
    <div className="relative isolate px-6 pt-14 lg:px-8">
      <div className="mx-auto max-w-2xl py-32 sm:py-48 lg:py-56">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-6xl dark:text-gray-100">
            {t('title')}
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-600">{message}</p>
          {/* <p className="mt-6 text-lg leading-8 text-gray-600">
            Anim aute id magna aliqua ad ad non deserunt sunt. Qui irure qui lorem cupidatat commodo. Elit sunt amet
            fugiat veniam occaecat fugiat aliqua.
          </p>
          <div className="mt-10 flex items-center justify-center gap-x-6">
            <a
              href="#"
              className="rounded-md bg-indigo-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
            >
              Get started
            </a>
            <a href="#" className="text-sm font-semibold leading-6 text-gray-900">
              Learn more <span aria-hidden="true">→</span>
            </a>
          </div> */}
        </div>
      </div>
    </div>
  );
};
