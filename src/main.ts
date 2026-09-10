import 'dotenv/config'
import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ValidationError } from "class-validator";
import helmet from "helmet";
import { AppModule } from "./app.module.js";


async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  app.enableCors({
    origin: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const flatten = (items: ValidationError[], prefix = ""): Array<{ property: string; messages: string[] }> =>
          items.flatMap((error) => {
            const property = prefix ? `${prefix}.${error.property}` : error.property;
            return [
              ...(error.constraints ? [{ property, messages: Object.values(error.constraints) }] : []),
              ...flatten(error.children ?? [], property),
            ];
          });
        const formattedErrors = flatten(errors);

        return new BadRequestException({
          statusCode: 400,
          message: "Validation failed",
          errors: formattedErrors,
        });
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("MyCOO Auth API")
    .setDescription(
      "Авторизация, регистрация, подтверждение кода и получение JWT",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup("swagger", app, document);

  const port = Number(process.env.PORT ?? 3001);
  if (process.env.HOST) await app.listen(port, process.env.HOST);
  else await app.listen(port);
}

bootstrap();
