import brandLogoUrlLight from "../assets/brand/logo-light.png";
import brandLogoUrlDark from "../assets/brand/logo-dark.png";

/** The static PI mark for the task-creation surface. No character assets. */
export function HomeBrandMark() {
  return (
    <span className="home-brand-mark" data-testid="home-brand-mark" aria-hidden="true">
      <img className="home-brand-logo home-brand-logo-dark" src={brandLogoUrlDark} alt="" width={40} height={40} draggable={false} />
      <img className="home-brand-logo home-brand-logo-light" src={brandLogoUrlLight} alt="" width={40} height={40} draggable={false} />
    </span>
  );
}
